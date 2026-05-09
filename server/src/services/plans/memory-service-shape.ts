// Narrow re-export of just the MemoryService surface plans needs.
// Avoids a hard import on the full service module so unit tests
// don't need to wire up pgvector.

export type {
  MemoryService,
  MemoryServiceContext,
} from "../memory/service.js";
