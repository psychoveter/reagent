"""
AgentRunner — the top-level runtime for a Reagent agent (Python).

One OS process per agent. Manages:
- Agent-level self_state ($self)
- Lifecycle handlers (on protocolCompleted, etc.)
- Protocol instances (one per active protocol run)
- Message routing to correct ProtocolInstance
"""

from __future__ import annotations
import asyncio
import uuid
from typing import Any, Optional, Callable

from .protocol_instance import ProtocolInstance
from .zone_executor import execute_zone, ReagentStub
from .types import msg_subscribe_pattern, trigger_subject


class AgentRunner:
    def __init__(self, config: dict[str, Any]) -> None:
        self.agent_name: str = config["agentIR"]["agentName"]
        self._agent_ir: dict[str, Any] = config["agentIR"]
        self._graphs: dict[str, dict[str, Any]] = config["graphs"]
        self._role_to_agent: dict[str, str] = config["roleToAgent"]

        # Accept either a pre-built transport or create NatsTransport from URL
        if "transport" in config:
            self._transport = config["transport"]
            self._is_nats = False
        else:
            from .nats_transport import NatsTransport
            self._transport = NatsTransport(config["natsUrl"])
            self._is_nats = True

        self._advance_hook = config.get("advanceHook")
        self._extras: Optional[dict[str, Any]] = config.get("extras")
        self._self: dict[str, Any] = {}
        self._instances: dict[str, ProtocolInstance] = {}
        self._completed_count = 0
        self._on_complete_callback: Optional[Callable[[str, str], None]] = None
        self._completion_event: asyncio.Event = asyncio.Event()
        self._expected_count = 0

    async def start(self) -> None:
        await self._transport.connect()

        init_action = self._agent_ir.get("initAction")
        if init_action:
            reagent = ReagentStub()
            extras = {"agent": self._extras} if self._extras else None
            execute_zone(init_action["body"], {}, self._self, reagent, extras=extras)

        if self._is_nats:
            await self._transport.subscribe(
                msg_subscribe_pattern(self.agent_name),
                self._handle_message_from_nats,
            )
            await self._transport.subscribe(
                trigger_subject(self.agent_name),
                self._handle_trigger_from_nats,
            )

    async def stop(self) -> None:
        await self._transport.close()

    async def wait_for_completion(self, expected_count: int, timeout_s: float = 30.0) -> None:
        self._expected_count = expected_count
        if self._completed_count >= expected_count:
            return
        try:
            await asyncio.wait_for(self._completion_event.wait(), timeout=timeout_s)
        except asyncio.TimeoutError:
            raise RuntimeError(
                f"Timeout: {self.agent_name} completed {self._completed_count}/{expected_count} instances"
            )

    @property
    def self_state(self) -> dict[str, Any]:
        return self._self

    @property
    def instances(self) -> dict[str, ProtocolInstance]:
        return self._instances

    @property
    def transport(self) -> Any:
        return self._transport

    def set_on_complete_callback(self, cb: Callable[[str, str], None]) -> None:
        """Register callback(instanceId, status) fired when any instance completes."""
        self._on_complete_callback = cb

    # ── Public dispatch API (used by IPC driver) ─────────────────

    def dispatch_message(self, env: dict[str, Any]) -> None:
        """Route an inbound message envelope to the correct ProtocolInstance."""
        instance_id = env.get("instanceId")
        instance = self._instances.get(instance_id)
        if not instance:
            return
        instance.dispatch_message(env)

    async def trigger_protocol(
        self,
        instance_id: str,
        protocol_name: str,
        input_data: Optional[dict[str, Any]] = None,
        role_to_agent: Optional[dict[str, str]] = None,
    ) -> Optional[ProtocolInstance]:
        """Start a new protocol instance (external entry point)."""
        return await self.start_protocol_instance(
            instance_id, protocol_name, input_data, role_to_agent,
        )

    # ── NATS subscription handlers ───────────────────────────────

    async def _handle_message_from_nats(self, data: Any, subject: str) -> None:
        env = data
        instance_id = env.get("instanceId")
        instance = self._instances.get(instance_id)
        if not instance:
            return
        instance.dispatch_message(env)

    async def _handle_trigger_from_nats(self, data: Any, subject: str) -> None:
        trigger = data
        await self.start_protocol_instance(
            trigger["instanceId"],
            trigger["protocolName"],
            trigger.get("input"),
            trigger.get("roleToAgent"),
        )

    # ── Instance management ──────────────────────────────────────

    async def start_protocol_instance(
        self,
        instance_id: str,
        protocol_name: str,
        input_data: Optional[dict[str, Any]] = None,
        role_to_agent_override: Optional[dict[str, str]] = None,
    ) -> Optional[ProtocolInstance]:
        binding = next(
            (p for p in self._agent_ir["plays"] if p["protocolName"] == protocol_name),
            None,
        )
        if not binding:
            return None

        graph_key = f"{protocol_name}.{binding['roleName']}"
        graph = self._graphs.get(graph_key)
        if not graph:
            return None

        rta = role_to_agent_override or self._role_to_agent

        config: dict[str, Any] = {
            "instanceId": instance_id,
            "protocolName": protocol_name,
            "agentName": self.agent_name,
            "roleName": binding["roleName"],
            "roleToAgent": rta,
            "input": input_data,
            "advanceHook": self._advance_hook,
        }
        if self._extras:
            config["extras"] = self._extras

        instance = ProtocolInstance(graph, self._transport, self._self, config)
        self._instances[instance_id] = instance

        instance.set_on_complete(
            lambda status, iid=instance_id, pn=protocol_name: self._handle_instance_complete(iid, pn, status)
        )

        instance.set_invoke_callback(
            lambda child_proto, child_input: self._invoke_child_protocol(instance_id, child_proto, child_input)
        )
        instance.set_spawn_callback(
            lambda child_proto, child_input: self._spawn_child_protocol(instance_id, child_proto, child_input)
        )

        asyncio.get_event_loop().create_task(instance.run())
        return instance

    async def _invoke_child_protocol(
        self, parent_instance_id: str, child_proto_name: str, child_input: Optional[dict[str, Any]] = None,
    ) -> Any:
        binding = next(
            (p for p in self._agent_ir["plays"] if p["protocolName"] == child_proto_name), None,
        )
        if not binding:
            raise RuntimeError(f"Agent {self.agent_name} has no binding for protocol '{child_proto_name}'")

        graph_key = f"{child_proto_name}.{binding['roleName']}"
        graph = self._graphs.get(graph_key)
        if not graph:
            raise RuntimeError(f"No graph for '{graph_key}'")

        child_id = f"{parent_instance_id}__invoke__{child_proto_name}__{uuid.uuid4().hex[:8]}"
        rta = self._role_to_agent

        config: dict[str, Any] = {
            "instanceId": child_id,
            "protocolName": child_proto_name,
            "agentName": self.agent_name,
            "roleName": binding["roleName"],
            "roleToAgent": rta,
            "input": child_input,
            "advanceHook": self._advance_hook,
        }
        if self._extras:
            config["extras"] = self._extras

        child_instance = ProtocolInstance(graph, self._transport, self._self, config)
        self._instances[child_id] = child_instance

        child_instance.set_invoke_callback(
            lambda proto, inp: self._invoke_child_protocol(child_id, proto, inp)
        )
        child_instance.set_spawn_callback(
            lambda proto, inp: self._spawn_child_protocol(child_id, proto, inp)
        )

        result_future: asyncio.Future = asyncio.get_event_loop().create_future()

        def _on_child_complete(status: str) -> None:
            if status == "completed":
                val, _ = child_instance.get_return_value()
                result_future.set_result(val)
            else:
                result_future.set_exception(RuntimeError(f"Child protocol '{child_proto_name}' {status}"))

        child_instance.set_on_complete(_on_child_complete)
        asyncio.get_event_loop().create_task(child_instance.run())
        return await result_future

    def _spawn_child_protocol(
        self, parent_instance_id: str, child_proto_name: str, child_input: Optional[dict[str, Any]] = None,
    ) -> None:
        binding = next(
            (p for p in self._agent_ir["plays"] if p["protocolName"] == child_proto_name), None,
        )
        if not binding:
            return

        graph_key = f"{child_proto_name}.{binding['roleName']}"
        graph = self._graphs.get(graph_key)
        if not graph:
            return

        child_id = f"{parent_instance_id}__spawn__{child_proto_name}__{uuid.uuid4().hex[:8]}"
        rta = self._role_to_agent

        config: dict[str, Any] = {
            "instanceId": child_id,
            "protocolName": child_proto_name,
            "agentName": self.agent_name,
            "roleName": binding["roleName"],
            "roleToAgent": rta,
            "input": child_input,
            "advanceHook": self._advance_hook,
        }
        if self._extras:
            config["extras"] = self._extras

        child_instance = ProtocolInstance(graph, self._transport, self._self, config)
        self._instances[child_id] = child_instance

        child_instance.set_invoke_callback(
            lambda proto, inp: self._invoke_child_protocol(child_id, proto, inp)
        )
        child_instance.set_spawn_callback(
            lambda proto, inp: self._spawn_child_protocol(child_id, proto, inp)
        )

        child_instance.set_on_complete(
            lambda status, iid=child_id, pn=child_proto_name: self._handle_instance_complete(iid, pn, status)
        )
        asyncio.get_event_loop().create_task(child_instance.run())

    def _handle_instance_complete(self, instance_id: str, protocol_name: str, status: str) -> None:
        self._completed_count += 1

        for handler in self._agent_ir.get("lifecycleHandlers", []):
            should_fire = False
            if handler["event"] == "protocolCompleted" and status == "completed":
                should_fire = True
            if handler["event"] == "protocolFailed" and status == "failed":
                should_fire = True

            if should_fire and handler.get("protocolFilter"):
                should_fire = handler["protocolFilter"] == protocol_name

            if should_fire:
                reagent = ReagentStub()
                execute_zone(handler["action"]["body"], {}, self._self, reagent)

        if self._on_complete_callback:
            self._on_complete_callback(instance_id, status)

        if self._completed_count >= self._expected_count:
            self._completion_event.set()
