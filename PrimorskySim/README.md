# PrimorskySim

Multiplayer open-world симулятор жизни в Приморском районе Санкт-Петербурга (состояние 2026), Unreal Engine 5, Windows PC, dedicated server.

Этап 0 (архитектура и пайплайн данных мира). Начинать с `Docs/PROJECT_STATE.md`.

```
pip install jsonschema
python3 Tools/WorldPipeline/validate_world.py          # → WorldReference/Validation/WorldValidationReport.md
python3 -m unittest discover -s Tools/WorldPipeline/tests
```

Карта данных © участники OpenStreetMap (ODbL), когда будет загружена.
