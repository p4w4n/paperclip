export interface DeliveryRow {
  id: string;
  deliveryId: string;
  eventType: string;
  action: string | null;
  prUrl: string | null;
  signatureValid: boolean;
  result: string;
  receivedAt: string;
}

export async function rotateGithubSecret(
  companyId: string,
): Promise<{ secret: string; instructions: string }> {
  const r = await fetch(
    `/api/companies/${encodeURIComponent(companyId)}/webhooks/github/_secret/rotate`,
    { method: "POST", credentials: "include" },
  );
  if (!r.ok) throw new Error(`rotate failed: ${r.status}`);
  return r.json();
}

export async function listGithubDeliveries(companyId: string): Promise<DeliveryRow[]> {
  const r = await fetch(
    `/api/companies/${encodeURIComponent(companyId)}/webhooks/github/deliveries`,
    { credentials: "include" },
  );
  if (!r.ok) throw new Error(`list deliveries failed: ${r.status}`);
  const j = await r.json();
  return j.deliveries;
}
