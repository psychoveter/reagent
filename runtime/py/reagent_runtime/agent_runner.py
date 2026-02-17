"""
AgentRunner — the top-level runtime for a Reagent agent (Python).

One OS process per agent. Manages:
- Agent-level self_state ($self)
- Lifecycle handlers (on protocolCompleted, etc.)
- Protocol instances (one per active protocol run)
- Message routing from NATS to correct ProtocolInstance
"""

from __future__ import annotations
import asyncio
from typing import Any, Optional, Callable

from .nats_transport import NatsTransport
from .protocol_instance import ProtocolInstance
from .zone_executor import execute_zone, ReagentStub
from .types import msg_subscribe_pattern, trigger_subject


class AgentRunner:
    def __init__(self, config: dict[str, Any]) -> None:
        self.agent_name: str = config["agentIR"]["agentName"]
        self._agent_ir: dict[str, Any] = config["agentIR"]
        self._graphs: dict[str, dict[str, Any]] = config["graphs"]
        self._transport = NatsTransport(config["natsUrl"])
        self._role_to_agent: dict[str, str] = config["roleToAgent"]

        self._self: dict[str, Any] = {}
        self._instances: dict[str, ProtocolInstance] = {}
        self._completed_count = 0
        self._on_all_done: Optional[Callable[[], None]] = None
        self._completion_event: asyncio.Event = asyncio.Event()
        self._expected_count = 0

    async def start(self) -> None:
        await self._transport.connect()

        # Run init zone
        init_action = self._agent_ir.get("initAction")
        if init_action:
            reagent = ReagentStub()
            execute_zone(init_action["body"], {}, self._self, reagent)

        # Subscribe to messages for this agent
        await self._transport.subscribe(
            msg_subscribe_pattern(self.agent_name),
            self._handle_message,
        )

        # Subscribe to trigger messages
        await self._transport.subscribe(
            trigger_subject(self.agent_name),
            self._handle_trigger,
        )

        print(f"[{self.agent_name}] Agent started, subscribed to messages")

    async def stop(self) -> None:
        await self._transport.close()
        print(f"[{self.agent_name}] Agent stopped")

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
    def transport(self) -> NatsTransport:
        return self._transport

    async def _handle_message(self, data: Any, subject: str) -> None:
        env = data
        instance_id = env.get("instanceId")
        instance = self._instances.get(instance_id)
        if not instance:
            print(f"[{self.agent_name}] No instance for {instance_id}, ignoring message {env.get('messageName')}")
            return
        instance.dispatch_message(env)

    async def _handle_trigger(self, data: Any, subject: str) -> None:
        trigger = data
        await self.start_protocol_instance(
            trigger["instanceId"],
            trigger["protocolName"],
            trigger.get("input"),
            trigger.get("roleToAgent"),
        )

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
            print(f"[{self.agent_name}] No plays binding for protocol {protocol_name}")
            return None

        graph_key = f"{protocol_name}.{binding['roleName']}"
        graph = self._graphs.get(graph_key)
        if not graph:
            print(f"[{self.agent_name}] No IRGraph for {graph_key}")
            return None

        rta = role_to_agent_override or self._role_to_agent

        config = {
            "instanceId": instance_id,
            "protocolName": protocol_name,
            "agentName": self.agent_name,
            "roleName": binding["roleName"],
            "roleToAgent": rta,
            "input": input_data,
        }

        instance = ProtocolInstance(graph, self._transport, self._self, config)
        self._instances[instance_id] = instance

        instance.set_on_complete(
            lambda status, iid=instance_id, pn=protocol_name: self._handle_instance_complete(iid, pn, status)
        )

        asyncio.get_event_loop().create_task(instance.run())
        return instance

    def _handle_instance_complete(self, instance_id: str, protocol_name: str, status: str) -> None:
        self._completed_count += 1
        print(f"[{self.agent_name}] Instance {instance_id} completed with status: {status}")

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

        if self._completed_count >= self._expected_count:
            self._completion_event.set()
