"""Reagent Python Agent Runtime."""
from .agent_runner import AgentRunner
from .protocol_instance import ProtocolInstance
from .local_transport import LocalTransport
from .zone_executor import execute_zone

try:
    from .nats_transport import NatsTransport
except ImportError:
    NatsTransport = None  # type: ignore[assignment,misc]

from .controller import ReagentController
from .agent_node import AgentHandle, AgentNode
from .inproc_agent_node import InprocAgentNode, InprocAgentHandle
from .ipc_agent_node import IpcAgentNode, IpcAgentHandle
from .inproc_transport import InprocTransport
from .remote_node import RemoteNode
from .otel_interceptor import create_otel_interceptor, create_otel_trace_hook, end_instance_span
from .protocol_engine import ProtocolEngine, duration_to_ms
from .agent_interface import AgentInterface, ManagedAgentAdapter
from .local_event_bus import LocalEventBus, BusEvent
from .cron_agent import CronAgent, parse_cron_expression, cron_matches_date
from .trigger_matcher import TriggerMatcher, TriggerEntry
from .trigger_policy import TriggerPolicy, TriggerPolicyState, evaluate_policy, DEFAULT_TRIGGER_POLICY
from .state_store import StateStore, InMemoryStateStore, StoreEntry, WatchEvent, Disposable, Lease
from .state_store_agent_registry import AgentRegistration, StateStoreAgentRegistry
from .resolve_policy_evaluator import ResolvePolicyEvaluator, ResolveContext

__all__ = [
    "AgentRunner",
    "ProtocolInstance",
    "NatsTransport",
    "LocalTransport",
    "execute_zone",
    "ReagentController",
    "AgentHandle",
    "AgentNode",
    "InprocAgentNode",
    "InprocAgentHandle",
    "IpcAgentNode",
    "IpcAgentHandle",
    "InprocTransport",
    "RemoteNode",
    "create_otel_interceptor",
    "create_otel_trace_hook",
    "end_instance_span",
    "ProtocolEngine",
    "duration_to_ms",
    "AgentInterface",
    "ManagedAgentAdapter",
    "LocalEventBus",
    "BusEvent",
    "CronAgent",
    "parse_cron_expression",
    "cron_matches_date",
    "TriggerMatcher",
    "TriggerEntry",
    "TriggerPolicy",
    "TriggerPolicyState",
    "evaluate_policy",
    "DEFAULT_TRIGGER_POLICY",
    "StateStore",
    "InMemoryStateStore",
    "StoreEntry",
    "WatchEvent",
    "Disposable",
    "Lease",
    "AgentRegistration",
    "StateStoreAgentRegistry",
    "ResolvePolicyEvaluator",
    "ResolveContext",
]
