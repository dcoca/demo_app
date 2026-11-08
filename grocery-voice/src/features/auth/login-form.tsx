"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Field, Input, Notice } from "@/components/ui";
import { supabaseBrowser } from "@/lib/supabase/browser";

type Mode = "signin" | "signup" | "magic";

export function LoginForm({ next, linkError }: { next: string; linkError: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "red" | "green"; text: string } | null>(
    linkError ? { tone: "red", text: "That sign-in link is invalid or expired. Request a new one." } : null,
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const supabase = supabaseBrowser();
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    try {
      if (mode === "magic") {
        const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });
        if (error) throw error;
        setMessage({ tone: "green", text: "Check your email for a sign-in link." });
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: redirectTo, data: { display_name: name } },
        });
        if (error) throw error;
        if (data.session) router.replace(next);
        else setMessage({ tone: "green", text: "Check your email to confirm your account." });
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace(next);
        router.refresh();
      }
    } catch (error) {
      setMessage({ tone: "red", text: error instanceof Error ? error.message : "Sign in failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="Sign in">
      <div role="tablist" className="surface grid grid-cols-3 rounded-xl p-1 text-sm">
        {(["signin", "signup", "magic"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`min-h-9 rounded-lg ${mode === m ? "bg-brand-600 text-white" : ""}`}
          >
            {m === "signin" ? "Sign in" : m === "signup" ? "Create account" : "Email link"}
          </button>
        ))}
      </div>
      {mode === "signup" ? (
        <Field label="Your name" htmlFor="name">
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoComplete="name" />
        </Field>
      ) : null}
      <Field label="Email" htmlFor="email">
        <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
      </Field>
      {mode !== "magic" ? (
        <Field label="Password" htmlFor="password" hint={mode === "signup" ? "At least 8 characters." : undefined}>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />
        </Field>
      ) : null}
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      <Button type="submit" disabled={busy} className="w-full">
        {busy ? "Working…" : mode === "magic" ? "Email me a link" : mode === "signup" ? "Create account" : "Sign in"}
      </Button>
    </form>
  );
}
