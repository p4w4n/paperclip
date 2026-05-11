import { useCallback, useEffect, useState } from "react";
import { Github, RefreshCw, Check, Copy, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  listGithubDeliveries,
  rotateGithubSecret,
  type DeliveryRow,
} from "../api/webhooks.js";

export interface GitHubWebhookCardProps {
  companyId: string;
}

export function GitHubWebhookCard({ companyId }: GitHubWebhookCardProps) {
  const [deliveries, setDeliveries] = useState<DeliveryRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Rotate modal state
  const [rotateState, setRotateState] = useState<
    "idle" | "rotating" | "done" | "error"
  >("idle");
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);
  const [confirmedSecret, setConfirmedSecret] = useState(false);

  const webhookUrl = `${window.location.origin}/api/companies/${companyId}/webhooks/github`;

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const rows = await listGithubDeliveries(companyId);
      setDeliveries(rows.slice(0, 5));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRotate() {
    setRotateState("rotating");
    setRotateError(null);
    setNewSecret(null);
    setSecretCopied(false);
    setConfirmedSecret(false);
    try {
      const res = await rotateGithubSecret(companyId);
      setNewSecret(res.secret);
      setRotateState("done");
    } catch (e) {
      setRotateError(e instanceof Error ? e.message : String(e));
      setRotateState("error");
    }
  }

  async function handleCopySecret() {
    if (!newSecret) return;
    try {
      await navigator.clipboard.writeText(newSecret);
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  function handleDismissModal() {
    setRotateState("idle");
    setNewSecret(null);
    setRotateError(null);
    setSecretCopied(false);
    setConfirmedSecret(false);
  }

  return (
    <div className="rounded-md border border-border px-4 py-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Github className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">GitHub Webhook</span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleRotate}
          disabled={rotateState === "rotating"}
          data-testid="rotate-secret-button"
        >
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          {rotateState === "rotating" ? "Rotating…" : "Rotate Secret"}
        </Button>
      </div>

      {/* Webhook URL */}
      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Webhook URL
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5">
          <code className="flex-1 truncate font-mono text-xs">{webhookUrl}</code>
          <CopyButton text={webhookUrl} label="Copy URL" />
        </div>
      </div>

      {/* Deliveries */}
      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Recent Deliveries
        </div>
        {loadError && (
          <p className="text-xs text-destructive">{loadError}</p>
        )}
        {!deliveries && !loadError && (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
        {deliveries && deliveries.length === 0 && (
          <p className="text-xs text-muted-foreground">No deliveries yet.</p>
        )}
        {deliveries && deliveries.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  <th className="py-1.5 pr-3 text-left font-medium">Delivery ID</th>
                  <th className="py-1.5 pr-3 text-left font-medium">Event</th>
                  <th className="py-1.5 pr-3 text-left font-medium">Action</th>
                  <th className="py-1.5 pr-3 text-left font-medium">Result</th>
                  <th className="py-1.5 text-left font-medium">Received</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {deliveries.map((d) => (
                  <tr key={d.id} className="group">
                    <td className="py-1.5 pr-3 font-mono text-xs truncate max-w-[120px]">
                      {d.deliveryId}
                    </td>
                    <td className="py-1.5 pr-3">{d.eventType}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground">
                      {d.action ?? "—"}
                    </td>
                    <td className="py-1.5 pr-3">
                      <DeliveryResultPill result={d.result} signatureValid={d.signatureValid} />
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {new Date(d.receivedAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Rotate Secret Modal */}
      {(rotateState === "done" || rotateState === "error") && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="relative w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-xl space-y-4">
            <button
              className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
              onClick={handleDismissModal}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>

            {rotateState === "error" && (
              <>
                <h3 className="text-sm font-semibold text-destructive">Rotation failed</h3>
                <p className="text-sm text-muted-foreground">{rotateError}</p>
                <Button size="sm" onClick={handleDismissModal}>Dismiss</Button>
              </>
            )}

            {rotateState === "done" && newSecret && (
              <>
                <h3 className="text-sm font-semibold">New Webhook Secret</h3>
                <p className="text-xs text-muted-foreground">
                  This secret is shown <strong>once</strong>. Copy it and configure it in GitHub
                  before dismissing.
                </p>
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                  <code
                    className="flex-1 truncate font-mono text-xs select-all"
                    data-testid="new-secret-value"
                  >
                    {newSecret}
                  </code>
                  <button
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={handleCopySecret}
                    aria-label="Copy secret"
                  >
                    {secretCopied ? (
                      <Check className="h-3.5 w-3.5 text-green-600" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={confirmedSecret}
                    onChange={(e) => setConfirmedSecret(e.target.checked)}
                  />
                  I&apos;ve configured this secret in GitHub
                </label>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={!confirmedSecret}
                    onClick={handleDismissModal}
                    data-testid="confirm-secret-button"
                  >
                    Done
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DeliveryResultPill({
  result,
  signatureValid,
}: {
  result: string;
  signatureValid: boolean;
}) {
  let colorClass: string;
  if (result === "verified") {
    colorClass = "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
  } else if (result === "invalid_signature" || !signatureValid) {
    colorClass = "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
  } else if (result === "no_match") {
    colorClass = "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
  } else {
    colorClass = "bg-muted text-muted-foreground";
  }
  return (
    <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${colorClass}`}>
      {result}
    </span>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <button
      className="shrink-0 text-muted-foreground hover:text-foreground"
      onClick={handleCopy}
      aria-label={label}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-600" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}
