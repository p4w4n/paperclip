// Extracted from IssueChatThread.tsx as the first step toward fragmenting
// the 4,302-line component (item #11 in the optimization audit). Leaf
// component with no closure over IssueChatThread's local state — purely
// presentational. Used by IssueChatToolPart to render input/result blobs
// with a hover-revealed copy button.
//
// Future split candidates that should follow the same shape and live in
// this directory:
//   - IssueChatTextPart, IssueChatReasoningPart, IssueChatRollingToolPart
//   - IssueChatToolPart (depends on CopyablePreBlock + tool-formatter
//     helpers that should also be extracted)
//   - IssueChatUserMessage, IssueChatAssistantMessage, IssueChatSystemMessage
//   - IssueChatComposer (the largest single block; its own file is
//     warranted; closes over many co-located types and helpers that need to
//     be extracted alongside it)
//
// See perf/results/07-IssueChatThread-split/NOTES.md for the full plan.

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

export function CopyablePreBlock({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="group/pre relative">
      <pre className={className}>{children}</pre>
      <button
        type="button"
        className={cn(
          "absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 backdrop-blur-sm transition-opacity hover:text-foreground group-hover/pre:opacity-100",
          copied && "opacity-100",
        )}
        title="Copy"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(children).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}
