#!/bin/bash

cd ../../../runtime/py
python -m reagent_runtime.remote_node_cli \
    --ros-url ws://127.0.0.1:18789 \
    --node-id node-py-1 \
    --agents-dir ../../examples/projects/auction-sim/agents