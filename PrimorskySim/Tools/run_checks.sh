#!/usr/bin/env bash
# Быстрые проверки без движка: данные мира + ядро симуляции. Запуск из корня PrimorskySim.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 Tools/WorldPipeline/validate_world.py
python3 -m unittest discover -s Tools/WorldPipeline/tests
CXX=${CXX:-g++}
$CXX -std=c++17 -Wall -Wextra -Werror -ISource/PrimSimCore/Public Tests/SimCore/SimCoreTests.cpp -o /tmp/primsim_simcore_tests
/tmp/primsim_simcore_tests
