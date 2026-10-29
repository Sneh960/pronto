"use client";

import { useState } from "react";

export function CopyButton({ text, label = "Copy" }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for browsers without the async clipboard API.
      const el = document.createElement("textarea");
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <button type="button" className="btn btn-copy" onClick={handleCopy}>
      {copied ? "Copied ✓" : label}
    </button>
  );
}

function download(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ResultBlock({ title, subtitle, filename, content, badge }) {
  return (
    <section className="result-card">
      <div className="result-head">
        <div>
          <h3>{title}</h3>
          {subtitle ? <div className="sub">{subtitle}</div> : null}
        </div>
        <div className="actions">
          {badge}
          {filename ? (
            <button
              type="button"
              className="btn btn-copy"
              onClick={() => download(filename, content)}
            >
              Download
            </button>
          ) : null}
          <CopyButton text={content} />
        </div>
      </div>
      <pre>{content}</pre>
    </section>
  );
}
