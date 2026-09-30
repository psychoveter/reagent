# Process

В `docs/decks/` лежат презентации по документации и архитектуре Reagent.

## Структура

Каждая презентация живет в своей папке:

```text
<deck-name>/
├── takes.md      -- ключевые тезисы, которые должна адресовать дека
├── slides.md     -- основной контент (Slidev, canonical)
└── <deck>.pdf    -- экспортированный PDF (опционально)
```

## Движок

Основной движок: **Slidev**.

- тема: `seriph`
- формат: `slides.md`
- экспорт: `slidev export`

## Команды

Запускать из `docs/decks/`:

```bash
npm run dev:deep-dive
npm run export:deep-dive
npm run export:all
```

## Процесс работы

1. Сначала обновляем `takes.md`, чтобы зафиксировать целевое сообщение деки.
2. Затем обновляем `slides.md` как канонический исходник.
3. После этого экспортируем PDF через `npm run export:<deck-name>`.

## Текущие деки

- `deep-dive/` — архитектурный обзор current docs и future docs Reagent
- `startupcamp/` — питч-дека: клинический кейс → платформа → сертификация → язык и рантайм Reagent (материалы в `startupcamp/files/`)
- `competitors/` — конкурентная карта multi-agent orchestration: workflow graphs, swarms, interaction protocols и defensible positioning Reagent
