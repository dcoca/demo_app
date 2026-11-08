"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import { Badge, Button, cx, Field, Input, Notice } from "@/components/ui";
import { api, ApiError, newIdempotencyKey } from "@/lib/api-client";
import { formatQuantity, SOURCE_LABEL, timeAgo } from "@/lib/format";
import { supabaseBrowser } from "@/lib/supabase/browser";
import type { IngestionResult } from "@/server/integrations/types";
import type { Profile, ShoppingItem } from "@/types/domain";
import { parseSpokenList } from "./parse-spoken";

type ListItem = ShoppingItem & { pending?: boolean };

type Action =
  | { type: "upsert"; item: ListItem; force?: boolean }
  | { type: "remove"; id: string }
  | { type: "replaceAll"; items: ShoppingItem[] };

function reducer(state: Record<string, ListItem>, action: Action): Record<string, ListItem> {
  switch (action.type) {
    case "upsert": {
      const existing = state[action.item.id];
      // Ignore out-of-order realtime events carrying an older version.
      if (!action.force && existing && !existing.pending && existing.version > action.item.version) return state;
      if (action.item.status === "removed") {
        const { [action.item.id]: _gone, ...rest } = state;
        void _gone;
        return rest;
      }
      return { ...state, [action.item.id]: action.item };
    }
    case "remove": {
      const { [action.id]: _gone, ...rest } = state;
      void _gone;
      return rest;
    }
    case "replaceAll": {
      const pending = Object.values(state).filter((i) => i.pending);
      return Object.fromEntries([...action.items, ...pending].map((i) => [i.id, i]));
    }
  }
}

interface Props {
  householdId: string;
  cycleId: string;
  initialItems: ShoppingItem[];
  profiles: Record<string, Profile>;
  currentUserId: string;
}

export function ShoppingList({ householdId, cycleId, initialItems, profiles, currentUserId }: Props) {
  const router = useRouter();
  const [itemsById, dispatch] = useReducer(reducer, initialItems, (items) =>
    Object.fromEntries(items.map((i) => [i.id, i as ListItem])),
  );
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ item: ShoppingItem; label: string } | null>(null);
  const [editing, setEditing] = useState<ShoppingItem | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [live, setLive] = useState<"connecting" | "live" | "offline">("connecting");

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 6000);
    return () => clearTimeout(t);
  }, [undo]);

  const { active, completed } = useMemo(() => {
    const all = Object.values(itemsById).sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { active: all.filter((i) => i.status === "active"), completed: all.filter((i) => i.status === "completed") };
  }, [itemsById]);

  // ---- Server sync -------------------------------------------------------
  const resync = useCallback(async () => {
    const { data, error: err } = await supabaseBrowser()
      .from("shopping_items")
      .select("*")
      .eq("cycle_id", cycleId)
      .neq("status", "removed");
    if (!err && data) dispatch({ type: "replaceAll", items: data as ShoppingItem[] });
  }, [cycleId]);

  const fetchItems = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    const { data } = await supabaseBrowser().from("shopping_items").select("*").in("id", ids);
    for (const item of (data ?? []) as ShoppingItem[]) dispatch({ type: "upsert", item });
  }, []);

  useEffect(() => {
    const supabase = supabaseBrowser();
    const channel = supabase
      .channel(`household:${householdId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "shopping_items", filter: `household_id=eq.${householdId}` },
        (payload) => {
          const item = payload.new as ShoppingItem;
          if (!item?.id) return;
          if (item.cycle_id !== cycleId) dispatch({ type: "remove", id: item.id });
          else dispatch({ type: "upsert", item });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "orders", filter: `household_id=eq.${householdId}` },
        () => router.refresh(),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setLive("live");
          void resync(); // catch anything missed while disconnected
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setLive("offline");
        }
      });

    const onVisible = () => document.visibilityState === "visible" && void resync();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void supabase.removeChannel(channel);
    };
  }, [householdId, cycleId, resync, router]);

  // ---- Mutations ---------------------------------------------------------
  async function addItems(inputs: Array<Partial<ShoppingItem> & { name: string }>) {
    setError(null);
    const key = newIdempotencyKey();
    const temps: ListItem[] = inputs.map((input, i) => ({
      id: `temp-${key}-${i}`,
      household_id: householdId,
      cycle_id: cycleId,
      name: input.name,
      normalized_name: input.name.toLowerCase(),
      quantity: input.quantity ?? null,
      unit: input.unit ?? null,
      brand: input.brand ?? null,
      notes: input.notes ?? null,
      organic: input.organic ?? false,
      upc: null,
      status: "active",
      source: "web",
      added_by: currentUserId,
      added_by_label: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null,
      removed_at: null,
      version: 0,
      pending: true,
    }));
    temps.forEach((item) => dispatch({ type: "upsert", item }));

    try {
      // Same Idempotency-Key on every retry: a retried request cannot add twice.
      const result = await api<IngestionResult>(`/api/v1/households/${householdId}/items`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: {
          items: inputs.map((i) => ({
            name: i.name,
            quantity: i.quantity ?? null,
            unit: i.unit ?? null,
            brand: i.brand ?? null,
            notes: i.notes ?? null,
            organic: i.organic ?? false,
          })),
        },
        retries: 3,
      });
      temps.forEach((t) => dispatch({ type: "remove", id: t.id }));
      await fetchItems(result.results.map((r) => r.itemId));
    } catch (err) {
      temps.forEach((t) => dispatch({ type: "remove", id: t.id }));
      setError(err instanceof Error ? err.message : "Could not add the item");
    }
  }

  async function updateItem(item: ShoppingItem, patch: Partial<ShoppingItem>): Promise<boolean> {
    setError(null);
    const optimistic = { ...item, ...patch, version: item.version };
    dispatch({ type: "upsert", item: optimistic, force: true });
    try {
      const saved = await api<ShoppingItem>(`/api/v1/households/${householdId}/items/${item.id}`, {
        method: "PATCH",
        body: { expectedVersion: item.version, ...patch },
      });
      dispatch({ type: "upsert", item: saved, force: true });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const current = (err.details as { current?: ShoppingItem } | undefined)?.current;
        if (current) dispatch({ type: "upsert", item: current, force: true });
        setError("Someone else changed that item. You're seeing the latest version.");
      } else {
        dispatch({ type: "upsert", item, force: true });
        setError(err instanceof Error ? err.message : "Could not save the change");
      }
      return false;
    }
  }

  async function removeItem(item: ShoppingItem) {
    dispatch({ type: "remove", id: item.id });
    try {
      const saved = await api<ShoppingItem>(`/api/v1/households/${householdId}/items/${item.id}`, {
        method: "PATCH",
        body: { expectedVersion: item.version, status: "removed" },
      });
      setUndo({ item: saved, label: item.name });
    } catch (err) {
      dispatch({ type: "upsert", item, force: true });
      setError(err instanceof Error ? err.message : "Could not remove the item");
    }
  }

  async function undoRemove() {
    if (!undo) return;
    const { item } = undo;
    setUndo(null);
    const ok = await updateItem(item, { status: "active" });
    if (!ok) await resync();
  }

  return (
    <div className="space-y-4">
      <AddItemForm onAdd={addItems} />

      {error ? <Notice tone="red">{error}</Notice> : null}

      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">
          {active.length} {active.length === 1 ? "item" : "items"}
        </h1>
        <span className="text-muted flex items-center gap-1.5 text-xs" aria-live="polite">
          <span
            aria-hidden
            className={cx("h-2 w-2 rounded-full", live === "live" ? "bg-brand-500" : live === "offline" ? "bg-amber-500" : "bg-gray-400")}
          />
          {live === "live" ? "Live" : live === "offline" ? "Reconnecting…" : "Connecting…"}
        </span>
      </div>

      {active.length === 0 ? (
        <div className="surface text-muted rounded-2xl p-6 text-center text-sm">
          Nothing on the list yet. Add something above, or say &ldquo;Hey Siri, add milk to groceries.&rdquo;
        </div>
      ) : (
        <ul className="surface divide-y divide-[var(--border)] rounded-2xl" aria-label="Shopping list">
          {active.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              profiles={profiles}
              onToggle={() => updateItem(item, { status: "completed" })}
              onEdit={() => setEditing(item)}
            />
          ))}
        </ul>
      )}

      {completed.length > 0 ? (
        <div>
          <button
            className="text-muted min-h-11 text-sm font-medium"
            aria-expanded={showCompleted}
            onClick={() => setShowCompleted((v) => !v)}
          >
            {showCompleted ? "Hide" : "Show"} completed ({completed.length})
          </button>
          {showCompleted ? (
            <ul className="surface mt-2 divide-y divide-[var(--border)] rounded-2xl opacity-80" aria-label="Completed items">
              {completed.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  profiles={profiles}
                  onToggle={() => updateItem(item, { status: "active" })}
                  onEdit={() => setEditing(item)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {undo ? (
        <div role="status" className="fixed inset-x-4 bottom-24 z-30 mx-auto flex max-w-md items-center justify-between rounded-xl bg-neutral-900 px-4 py-3 text-sm text-white shadow-lg sm:bottom-6">
          <span className="truncate">Removed {undo.label}</span>
          <button className="ml-4 font-semibold text-brand-100" onClick={undoRemove}>
            Undo
          </button>
        </div>
      ) : null}

      {editing ? (
        <EditItemDialog
          item={itemsById[editing.id] ?? editing}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            const current = itemsById[editing.id] ?? editing;
            if (await updateItem(current, patch)) setEditing(null);
          }}
          onRemove={async () => {
            const current = itemsById[editing.id] ?? editing;
            setEditing(null);
            await removeItem(current);
          }}
        />
      ) : null}
    </div>
  );
}

function ItemRow({
  item,
  profiles,
  onToggle,
  onEdit,
}: {
  item: ListItem;
  profiles: Record<string, Profile>;
  onToggle: () => void;
  onEdit: () => void;
}) {
  const done = item.status === "completed";
  const who = item.added_by ? profiles[item.added_by]?.display_name : null;
  const via = item.source === "web" ? null : item.added_by_label ?? SOURCE_LABEL[item.source];
  const qty = formatQuantity(item.quantity, item.unit);

  return (
    <li className={cx("flex items-start gap-3 px-3 py-2.5", item.pending && "opacity-60")}>
      <button
        onClick={onToggle}
        disabled={item.pending}
        aria-label={done ? `Restore ${item.name}` : `Mark ${item.name} as done`}
        aria-pressed={done}
        className="flex h-11 w-11 shrink-0 items-center justify-center"
      >
        <span
          className={cx(
            "flex h-6 w-6 items-center justify-center rounded-full border-2",
            done ? "border-brand-600 bg-brand-600 text-white" : "border-[var(--muted)]",
          )}
        >
          {done ? (
            <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={3}>
              <path d="M5 12l5 5L20 7" />
            </svg>
          ) : null}
        </span>
      </button>
      <button onClick={onEdit} disabled={item.pending} className="min-w-0 flex-1 py-1 text-left">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cx("font-medium first-letter:uppercase", done && "line-through")}>{item.name}</span>
          {qty ? <Badge>{qty}</Badge> : null}
          {item.organic ? <Badge tone="green">organic</Badge> : null}
          {item.brand ? <Badge tone="blue">{item.brand}</Badge> : null}
        </div>
        {item.notes ? <p className="text-muted mt-0.5 truncate text-sm">{item.notes}</p> : null}
        <p className="text-muted mt-0.5 text-xs">
          {item.pending ? "Saving…" : [who, via, timeAgo(item.created_at)].filter(Boolean).join(" · ")}
        </p>
      </button>
    </li>
  );
}

function AddItemForm({ onAdd }: { onAdd: (items: Array<Partial<ShoppingItem> & { name: string }>) => Promise<void> }) {
  const [text, setText] = useState("");
  const [details, setDetails] = useState(false);
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [brand, setBrand] = useState("");
  const [notes, setNotes] = useState("");
  const [organic, setOrganic] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    let items: Array<Partial<ShoppingItem> & { name: string }>;
    if (details) {
      items = [
        {
          name: value,
          quantity: quantity ? Number(quantity) : null,
          unit: unit || null,
          brand: brand || null,
          notes: notes || null,
          organic,
        },
      ];
    } else {
      // "2 gallons milk, eggs and bananas" -> three items
      items = parseSpokenList(value).map((p) => ({ name: p.name, quantity: p.quantity ?? null, unit: p.unit ?? null }));
      if (items.length === 0) return;
    }
    setText("");
    setQuantity("");
    setUnit("");
    setBrand("");
    setNotes("");
    setOrganic(false);
    inputRef.current?.focus();
    void onAdd(items);
  }

  return (
    <form onSubmit={submit} className="surface space-y-3 rounded-2xl p-3" aria-label="Add items">
      <div className="flex gap-2">
        <label htmlFor="new-item" className="sr-only">
          Add an item
        </label>
        <Input
          id="new-item"
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={details ? "Item name" : "Add items, e.g. 2 gallons milk, eggs"}
          autoComplete="off"
          enterKeyHint="done"
          maxLength={details ? 120 : 1000}
        />
        <Button type="submit" aria-label="Add">
          Add
        </Button>
      </div>
      <button
        type="button"
        className="text-muted text-xs font-medium"
        aria-expanded={details}
        onClick={() => setDetails((v) => !v)}
      >
        {details ? "Fewer options" : "Quantity, brand, notes…"}
      </button>
      {details ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Quantity" htmlFor="qty">
            <Input id="qty" type="number" inputMode="decimal" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          <Field label="Unit" htmlFor="unit">
            <Input id="unit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="gallon, lb…" maxLength={32} />
          </Field>
          <Field label="Brand" htmlFor="brand">
            <Input id="brand" value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={80} />
          </Field>
          <Field label="Notes" htmlFor="notes">
            <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ripe, sliced…" maxLength={500} />
          </Field>
          <label className="col-span-2 flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" checked={organic} onChange={(e) => setOrganic(e.target.checked)} className="h-5 w-5" />
            Organic
          </label>
        </div>
      ) : null}
    </form>
  );
}

function EditItemDialog({
  item,
  onClose,
  onSave,
  onRemove,
}: {
  item: ShoppingItem;
  onClose: () => void;
  onSave: (patch: Partial<ShoppingItem>) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(item.name);
  const [quantity, setQuantity] = useState(item.quantity?.toString() ?? "");
  const [unit, setUnit] = useState(item.unit ?? "");
  const [brand, setBrand] = useState(item.brand ?? "");
  const [notes, setNotes] = useState(item.notes ?? "");
  const [organic, setOrganic] = useState(item.organic);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await onSave({
      name,
      quantity: quantity ? Number(quantity) : null,
      unit: unit || null,
      brand: brand || null,
      notes: notes || null,
      organic,
    });
    setBusy(false);
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="edit-title"
      className="surface m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl p-0 text-[var(--text)] backdrop:bg-black/40"
    >
      <form onSubmit={submit} className="space-y-3 p-4">
        <h2 id="edit-title" className="text-base font-semibold">
          Edit item
        </h2>
        <Field label="Name" htmlFor="edit-name">
          <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity" htmlFor="edit-qty">
            <Input id="edit-qty" type="number" inputMode="decimal" min="0" step="any" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </Field>
          <Field label="Unit" htmlFor="edit-unit">
            <Input id="edit-unit" value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={32} />
          </Field>
        </div>
        <Field label="Brand" htmlFor="edit-brand">
          <Input id="edit-brand" value={brand} onChange={(e) => setBrand(e.target.value)} maxLength={80} />
        </Field>
        <Field label="Notes" htmlFor="edit-notes" hint="Preparation or preferences, e.g. 'thin sliced'.">
          <Input id="edit-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={organic} onChange={(e) => setOrganic(e.target.checked)} className="h-5 w-5" />
          Organic
        </label>
        <div className="flex items-center justify-between gap-2 pt-2">
          <Button type="button" variant="ghost" className="text-red-600" onClick={onRemove}>
            Remove
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => ref.current?.close()}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
