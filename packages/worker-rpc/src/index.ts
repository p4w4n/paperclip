// Re-export protobuf-es generated types from the worker.proto definition.
// `pnpm generate` (via buf) populates `./generated/` before tsc runs.
export * from "./generated/paperclip/v1/worker_pb.js";
