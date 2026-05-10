import { EventEmitter } from "node:events";

export interface ArtifactsEventMap {
  declared: {
    id: string;
    companyId: string;
    issueId: string | null;
    kind: string;
    name: string;
    blobSha256: string;
    declaredAt: Date;
  };
}

class ArtifactsEvents extends EventEmitter {
  override emit<K extends keyof ArtifactsEventMap>(event: K, payload: ArtifactsEventMap[K]): boolean {
    return super.emit(event, payload);
  }
  override on<K extends keyof ArtifactsEventMap>(event: K, listener: (p: ArtifactsEventMap[K]) => void): this {
    return super.on(event, listener);
  }
}

export const artifactsEvents = new ArtifactsEvents();
