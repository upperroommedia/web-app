# Context Map

## Contexts

- [Web App](./apps/web/CONTEXT.md) - administers sermons, speakers, lists, series, uploads, search, and publishing status.
- [Firebase Functions](./functions/CONTEXT.md) - owns server-side callable workflows, Subsplash and SoundCloud mutations, list overflow, series membership, and operational alerts.
- [Process Audio](./apps/process-audio/CONTEXT.md) - trims, transcodes, merges intro/outro audio, and resolves YouTube audio through the production worker profiles.
- [Shared Domain Types](./packages/shared/CONTEXT.md) - defines cross-context domain records such as sermons, lists, series, speakers, users, and images.
- [Callable Contracts](./packages/contracts/CONTEXT.md) - defines the typed command and result shapes exchanged between the web app, Firebase functions, process-audio queues, and browser fallback.

## Relationships

- **Web App -> Callable Contracts**: Web workflows call Firebase and process-audio operations through typed contract payloads.
- **Firebase Functions -> Shared Domain Types**: Function workflows read and write canonical sermon, list, series, speaker, user, and image records.
- **Web App -> Shared Domain Types**: Admin UI renders and edits the same canonical records that functions mutate.
- **Firebase Functions -> Process Audio**: Media callables enqueue process-audio requests and observe queue state for storage-backed and YouTube-backed sermon audio.
- **Process Audio -> Callable Contracts**: Queue state, task payloads, and browser fallback messages use shared contract terms.
- **Firebase Functions <-> Subsplash/SoundCloud**: Publishing workflows synchronize local records with external media destinations.
