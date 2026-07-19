import type { EventEnvelope } from "../../shared/contracts.js";

type Client = { send(data: string): void; readyState: number };

export class EventHub {
  private sequence = 0;
  private clients = new Set<Client>();
  private recent: EventEnvelope[] = [];

  add(client: Client, workspaceId: string, lastSequence = 0) {
    this.clients.add(client);
    const oldest = this.recent[0]?.sequence ?? this.sequence;
    if (lastSequence && lastSequence < oldest - 1) client.send(JSON.stringify({ type: "workspace.resyncRequired", workspaceId, currentSequence: this.sequence }));
    else for (const event of this.recent) if (event.sequence > lastSequence) client.send(JSON.stringify(event));
    return () => this.clients.delete(client);
  }

  emit(workspaceId: string, event: EventEnvelope["event"]) {
    const envelope: EventEnvelope = { workspaceId, sequence: ++this.sequence, occurredAt: new Date().toISOString(), event };
    this.recent.push(envelope);
    if (this.recent.length > 500) this.recent.shift();
    const payload = JSON.stringify(envelope);
    for (const client of this.clients) if (client.readyState === 1) client.send(payload);
    return envelope;
  }

  clear() { this.recent = []; this.sequence = 0; }
  currentSequence() { return this.sequence; }
}
