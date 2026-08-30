// mind — personal capture endpoint. POST a url, text, base64 image or PDF;
// Claude catalogues it and the row lands in `items`. Also serves embed_query
// (semantic search vectors for the browse page) and reembed (backfill).
//
// Auth, either:
//   x-mind-secret: <MIND_SECRET>   — the iOS Shortcut
//   authorization: Bearer <jwt>    — the browse page, signed in as the owner
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const OWNER = "richardmpreston@me.com";
// where the browse page lives, so a capture can hand back a link to what it just
// saved — the Shortcut's finishing popup uses it
const APP = "https://richardmpreston.github.io/mind/";

const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
// gte-small ships inside the edge runtime — no key, no external calls
// deno-lint-ignore no-explicit-any
const embedder = new (globalThis as any).Supabase.ai.Session("gte-small");

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-mind-secret, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const textToHtml = (s: string) =>
  s.trim().split(/\n{2,}/).map((p) => "<p>" + escHtml(p).replace(/\n/g, "<br>") + "</p>").join("");

async function embed(text: string): Promise<string | null> {
  try {
    const v = await embedder.run(text.slice(0, 4000), { mean_pool: true, normalize: true });
    return "[" + Array.from(v as number[]).join(",") + "]";
  } catch (e) {
    console.error("embedding failed:", e);
    return null;
  }
}

const embedText = (r: { title?: string; summary?: string; tags?: string[]; body_text?: string | null; raw_text?: string | null }) =>
  [r.title, r.summary, (r.tags ?? []).join(" "), (r.body_text ?? r.raw_text ?? "").slice(0, 1500)]
    .filter(Boolean).join("\n");

// Trust the bytes, not the sender: Shortcuts base64-encodes images as PNG
// whatever the source, and Claude's API rejects mismatched media types.
function sniff(b: Uint8Array): string | null {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

async function store(bytes: Uint8Array, mt: string): Promise<string | null> {
  const path = crypto.randomUUID() + "." + (mt.split("/")[1] ?? "bin");
  const up = await supa.storage.from("mind").upload(path, bytes, { contentType: mt });
  if (up.error) { console.error("upload failed:", up.error.message); return null; }
  return path;
}

// The picture a page uses to headline itself. Copied into our own bucket rather
// than hotlinked: og:image URLs rot, some hosts refuse off-site loads, and the
// browse page already knows how to show a storage_path.
async function ogImage(pageUrl: string): Promise<{ bytes: Uint8Array; mt: string } | null> {
  try {
    // jina gives us the text but strips the head, so this is a second, cheap
    // read — head only, and a browser UA because bare fetches get 403s
    const r = await fetch(pageUrl, {
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const head = (await r.text()).slice(0, 200000);
    const tag = /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url|:url)?|twitter:image(?::src)?)["'][^>]*>/i.exec(head);
    const src = tag && /content=["']([^"']+)["']/i.exec(tag[0])?.[1];
    if (!src) return null;
    const img = await fetch(new URL(src, r.url), { signal: AbortSignal.timeout(15000) });
    if (!img.ok) return null;
    const bytes = new Uint8Array(await img.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) return null;
    const mt = sniff(bytes);
    // sniffed, not trusted from the header — and an SVG or an HTML error page
    // sniffs as nothing, which is exactly the answer we want
    return mt?.startsWith("image/") ? { bytes, mt } : null;
  } catch (e) {
    console.error("og:image failed:", e);
    return null;
  }
}

const META_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short descriptive title for the item" },
    summary: { type: "string", description: "1-3 sentence summary written for future reference" },
    tags: { type: "array", items: { type: "string" }, description: "3-8 lowercase topic tags" },
    category: { type: "string", description: "One broad category, e.g. article, recipe, product, tool, inspiration, idea, place, video, reference, other" },
    transcript: { type: "string", description: "ONLY for images that consist mainly of readable text (a screenshot of prose, a rendered quote): the text transcribed verbatim. Omit or leave empty for photos, graphics and PDFs." },
  },
  required: ["title", "summary", "tags", "category"],
  additionalProperties: false,
} as const;

const SYSTEM = "You catalogue items saved to a personal reference library (like mymind). " +
  "Given whatever was shared — a web page, a text note, an image or a PDF — produce a title, a short summary " +
  "useful for finding and recalling this later, lowercase tags, and one broad category. " +
  "If an image is mostly readable text, also transcribe it verbatim in the transcript field. " +
  "If page content is thin (paywall/teaser), work with whatever is available; never refuse.";

// Tags are only worth anything if they gather items. Show Claude the vocabulary
// it has already built so it reuses a tag rather than coining a synonym — while
// leaving it free to name something genuinely new.
const TAG_RULES =
  "Tag style: lowercase, one to three words, no punctuation beyond hyphens, singular unless the plural is the natural name.\n" +
  "Reuse an existing tag whenever it genuinely describes this item — that is what makes the library navigable.\n" +
  "Never force a fit: a tag that is only roughly right is worse than a new one. When the subject is new to this " +
  "library, coin a fresh tag in the same style. Aim for 3-8 tags, mixing broad ones that will gather many items " +
  "with a couple of specific ones.";

async function vocabulary(): Promise<[string, number][]> {
  const { data } = await supa.from("items").select("tags").is("deleted_at", null).limit(2000);
  const counts = new Map<string, number>();
  for (const r of data ?? []) for (const t of (r.tags ?? []) as string[]) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ponytail: whole vocabulary in the prompt. ~10 tokens each, so a few thousand
// tags still costs less than the page text; sample the top 400 if it ever grows past that.
const vocabPrompt = (v: [string, number][]) =>
  v.length === 0 ? "" : "\n\nTags already in this library (with how many items use each):\n" +
    v.slice(0, 400).map(([t, n]) => `${t} (${n})`).join(", ") + "\n\n" + TAG_RULES;

async function catalogue(content: unknown[]) {
  const vocab = vocabPrompt(await vocabulary());
  const resp = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 2048,
    system: SYSTEM + vocab,
    output_config: { format: { type: "json_schema", schema: META_SCHEMA } },
    messages: [{ role: "user", content }],
  } as never);
  const text = (resp as { content: { type: string; text?: string }[] }).content
    .find((b) => b.type === "text")?.text ?? "{}";
  return JSON.parse(text) as { title: string; summary: string; tags: string[]; category: string; transcript?: string };
}

const TIDY_SCHEMA = {
  type: "object",
  properties: {
    merges: {
      type: "array",
      description: "Different spellings of the SAME concept, collapsed to one",
      items: {
        type: "object",
        properties: {
          to: { type: "string", description: "The canonical tag to keep" },
          from: { type: "array", items: { type: "string" }, description: "Existing tags that mean exactly this" },
          why: { type: "string", description: "A few words on why these are the same thing" },
        },
        required: ["to", "from", "why"],
        additionalProperties: false,
      },
    },
    parents: {
      type: "array",
      description: "Umbrella tags ADDED alongside specific ones so related items gather",
      items: {
        type: "object",
        properties: {
          parent: { type: "string", description: "The broad gathering tag" },
          children: { type: "array", items: { type: "string" }, description: "Existing tags that sit under it" },
          why: { type: "string", description: "A few words on what this umbrella gathers" },
        },
        required: ["parent", "children", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["merges", "parents"],
  additionalProperties: false,
} as const;

// Two operations, deliberately kept apart: merging is lossy, so it is limited to
// tags that are literally the same word; breadth comes from adding an umbrella
// tag next to the specific one, which loses nothing.
async function planTidy(vocab: [string, number][]) {
  const resp = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 4096,
    system: "You are tidying the tag vocabulary of a personal reference library. It should grow broader as new " +
      "subjects arrive while staying coherent — one name per concept, and enough shared tags that related items " +
      "find each other.\n\n" +
      "MERGES — only where two tags name the identical concept and differ merely in wording: singular/plural " +
      "('recipe'/'recipes'), hyphenation, spelling, acronym vs expansion, or exact synonyms " +
      "('slow fashion'/'sustainable fashion').\n" +
      "NEVER merge a specific thing into a general one. 'world cup' is not 'sports'; 'brooks brothers' is not " +
      "'menswear'; 'trump administration' is not 'politics'; 'memoir' is not 'contemporary fiction'. Those " +
      "distinctions are the whole value of the tag. When in doubt, do not merge.\n\n" +
      "PARENTS — this is how breadth is added. Propose a small number of umbrella tags that will be added " +
      "ALONGSIDE the specific tags (nothing is removed), so that items scattered across near-singleton tags " +
      "gather under something searchable. A parent must cover at least two existing tags, be a natural name " +
      "someone would actually search for, and prefer wording already in the vocabulary. At most a dozen.\n\n" +
      "Most tags need neither treatment. Return only what is genuinely worth doing.",
    output_config: { format: { type: "json_schema", schema: TIDY_SCHEMA } },
    messages: [{ role: "user", content: "Tag vocabulary (tag, item count):\n" + vocab.map(([t, n]) => `${t} (${n})`).join("\n") }],
  } as never);
  const text = (resp as { content: { type: string; text?: string }[] }).content
    .find((b) => b.type === "text")?.text ?? '{"merges":[],"parents":[]}';
  return JSON.parse(text) as {
    merges: { to: string; from: string[]; why: string }[];
    parents: { parent: string; children: string[]; why: string }[];
  };
}

async function authorised(req: Request) {
  if (req.headers.get("x-mind-secret") === Deno.env.get("MIND_SECRET")) return true;
  const jwt = req.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (!jwt) return false;
  const { data } = await supa.auth.getUser(jwt);
  return data?.user?.email === OWNER;
}

function decode64(s: string): Uint8Array | null {
  try { return Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0)); }
  catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("POST only", { status: 405, headers: CORS });
  if (!await authorised(req)) return new Response("unauthorized", { status: 401, headers: CORS });

  let body: { url?: string; text?: string; body_html?: string; image_base64?: string;
    pdf_base64?: string; media_type?: string; embed_query?: string; reembed?: boolean;
    harmonise?: boolean; dry?: boolean;
    plan?: { merges: { to: string; from: string[]; why: string }[];
             parents: { parent: string; children: string[]; why: string }[] } };
  try { body = await req.json(); } catch { return new Response("bad json", { status: 400, headers: CORS }); }

  // --- semantic search: turn a query into a vector for the browse page ---
  if (body.embed_query) {
    const vec = await embed(body.embed_query);
    if (!vec) return new Response("embedding unavailable", { status: 503, headers: CORS });
    return Response.json({ embedding: JSON.parse(vec) }, { headers: CORS });
  }

  // --- harmonise the tag cloud: fold variants and synonyms into one canonical
  // form, leave genuinely distinct concepts alone. { harmonise: true } applies
  // the plan; add dry: true to see it first. ---
  if (body.harmonise) {
    const vocab = await vocabulary();
    if (!vocab.length) return Response.json({ merges: [], changed: 0 }, { headers: CORS });
    // pass a reviewed plan back to apply exactly that; omit it and Claude proposes one
    const plan = body.plan ?? await planTidy(vocab);
    // A tag proposed as an umbrella is by definition too broad to merge into:
    // Claude sometimes asks for both at once, and the merge is the wrong half.
    const umbrellas = new Set((plan.parents ?? []).map((p) => p.parent));
    plan.merges = (plan.merges ?? []).filter((m) => !umbrellas.has(m.to));
    const map = new Map<string, string>();
    for (const m of plan.merges) for (const f of m.from) if (f !== m.to) map.set(f, m.to);
    const parentOf = new Map<string, string[]>();
    for (const p of plan.parents ?? []) {
      for (const c of p.children) {
        const key = map.get(c) ?? c;
        parentOf.set(key, [...(parentOf.get(key) ?? []), p.parent]);
      }
    }
    if (body.dry) return Response.json({ ...plan, folding: map.size, vocabulary: vocab.length }, { headers: CORS });

    // ponytail: rewrites every row. Fine for a personal library; batch it if this
    // ever holds tens of thousands of items.
    const { data: rows } = await supa.from("items").select("id, tags").is("deleted_at", null).limit(2000);
    let changed = 0;
    for (const r of rows ?? []) {
      const before = (r.tags ?? []) as string[];
      const canonical = before.map((t) => map.get(t) ?? t);
      const after = [...new Set([...canonical, ...canonical.flatMap((t) => parentOf.get(t) ?? [])])];
      if (after.join("\u0000") === before.join("\u0000")) continue;
      await supa.from("items").update({ tags: after }).eq("id", r.id);
      changed++;
    }
    const now = await vocabulary();
    return Response.json({ merges: plan.merges, changed, before: vocab.length, after: now.length }, { headers: CORS });
  }

  // --- one-off/maintenance: embed rows that don't have a vector yet ---
  if (body.reembed) {
    const { data: rows } = await supa.from("items")
      .select("id, title, summary, tags, body_text, raw_text")
      .is("embedding", null).is("deleted_at", null).limit(200);
    let n = 0;
    for (const r of rows ?? []) {
      const vec = await embed(embedText(r));
      if (vec) { await supa.from("items").update({ embedding: vec }).eq("id", r.id); n++; }
    }
    return Response.json({ embedded: n }, { headers: CORS });
  }

  // Some apps share URLs as plain text — promote a bare-URL note to a link.
  // A URL on its own line within longer text also counts.
  if (!body.url && !body.image_base64 && !body.pdf_base64 && body.text) {
    const trimmed = body.text.trim();
    if (/^https?:\/\/\S+$/.test(trimmed)) {
      body.url = trimmed;
      delete body.text;
    } else {
      const lines = trimmed.split("\n").map((l) => l.trim());
      const urlLine = lines.find((l) => /^https?:\/\/\S+$/.test(l));
      if (urlLine) {
        body.url = urlLine;
        body.text = lines.filter((l) => l !== urlLine).join("\n").trim();
      }
    }
  }

  // a Shortcut image branch can deliver a PDF (coercion, wrong branch) — route by bytes
  if (body.image_base64) {
    const peek = decode64(body.image_base64.slice(0, 8));
    if (peek && peek[0] === 0x25 && peek[1] === 0x50 && peek[2] === 0x44 && peek[3] === 0x46) {
      body.pdf_base64 = body.image_base64;
      delete body.image_base64;
    }
  }

  let kind: string, source_url: string | null = null, raw_text: string | null = null,
      storage_path: string | null = null;
  let rich: { body_html?: string; body_text?: string } = {};
  // an image is uploaded only after Claude has looked at it — see the transcript
  // check below, where an image that is really text stops being an image
  let imgBytes: Uint8Array | null = null, imgMt = "";
  // a link's headline picture, fetched while Claude reads the page
  let heroP: Promise<{ bytes: Uint8Array; mt: string } | null> | null = null;
  const content: unknown[] = [];

  if (body.pdf_base64) {
    kind = "pdf";
    const bytes = decode64(body.pdf_base64);
    if (!bytes) return new Response("bad base64", { status: 400, headers: CORS });
    if (bytes.length > 20 * 1024 * 1024) return new Response("pdf too large (20MB max)", { status: 413, headers: CORS });
    storage_path = await store(bytes, "application/pdf");
    raw_text = body.text ?? null;
    let b64 = "";
    for (let i = 0; i < bytes.length; i += 32768) b64 += String.fromCharCode(...bytes.subarray(i, i + 32768));
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: btoa(b64) } });
    content.push({ type: "text", text: "Catalogue this PDF." + (raw_text ? " Shared with it: " + raw_text : "") });
  } else if (body.image_base64) {
    kind = "image";
    const bytes = decode64(body.image_base64);
    if (!bytes) return new Response("bad base64", { status: 400, headers: CORS });
    imgBytes = bytes;
    imgMt = sniff(bytes) ?? body.media_type ?? "image/jpeg";
    raw_text = body.text ?? null;
    let b64 = "";
    for (let i = 0; i < bytes.length; i += 32768) b64 += String.fromCharCode(...bytes.subarray(i, i + 32768));
    content.push({ type: "image", source: { type: "base64", media_type: imgMt, data: btoa(b64) } });
    content.push({ type: "text", text: "Catalogue this image." + (raw_text ? " Shared with it: " + raw_text : "") });
  } else if (body.url) {
    kind = "link";
    source_url = body.url;
    heroP = ogImage(body.url);
    const highlight = body.text && body.text.trim() && body.text.trim() !== body.url ? body.text.trim() : null;
    if (highlight) {
      rich = { body_html: "<blockquote>" + escHtml(highlight) + "</blockquote>", body_text: highlight };
    }
    let page = "";
    try {
      const r = await fetch("https://r.jina.ai/" + body.url, { signal: AbortSignal.timeout(20000) });
      if (r.ok) page = (await r.text()).slice(0, 20000);
    } catch (e) { console.error("jina fetch failed:", e); }
    raw_text = page ? page.slice(0, 5000) : highlight;
    content.push({
      type: "text",
      text: `Catalogue this saved link.\nURL: ${body.url}\n` +
        (highlight
          ? `The user highlighted this passage — it is the reason they saved the page. Weight the summary and tags towards it:\n\"${highlight}\"\n`
          : "") +
        "If the page shows one main item followed by comments, replies, or a feed of other posts, " +
        "catalogue only the main item and ignore everything after it.\n" +
        `Page content (may be partial or a paywall teaser):\n${page || "(unavailable — catalogue from the URL alone)"}`,
    });
  } else if (body.text) {
    kind = "note";
    raw_text = body.text;
    // UI notes bring their own markup; Shortcut-shared text is someone else's
    // words, so it lands as a quote
    rich = body.body_html
      ? { body_html: body.body_html, body_text: body.text }
      : { body_html: "<blockquote>" + textToHtml(body.text) + "</blockquote>", body_text: body.text };
    content.push({ type: "text", text: "Catalogue this note:\n" + body.text });
  } else {
    return new Response("nothing to save", { status: 400, headers: CORS });
  }

  // ponytail: capture never fails on AI errors — fall back to a bare titled row
  let meta;
  try {
    meta = await catalogue(content);
  } catch (e) {
    console.error("claude call failed:", e);
    meta = {
      title: source_url ? new URL(source_url).hostname : (raw_text ?? "Saved item").slice(0, 80),
      summary: "", tags: [], category: kind,
    };
  }

  const { transcript, ...fields } = meta;
  if (kind === "image" && transcript && transcript.trim()) {
    // iOS turns a shared text selection into a rendered picture of the text.
    // Words beat a screenshot of words: keep the quote, skip the upload.
    kind = "note";
    rich = { body_html: "<blockquote>" + escHtml(transcript.trim()) + "</blockquote>", body_text: transcript.trim() };
  } else if (imgBytes) {
    storage_path = await store(imgBytes, imgMt);
  }

  const hero = heroP ? await heroP : null;
  if (hero) storage_path = await store(hero.bytes, hero.mt);

  const embedding = await embed(embedText({ ...fields, ...rich, raw_text }));

  const { data, error } = await supa.from("items")
    .insert({ kind, source_url, raw_text, storage_path, ...fields, ...rich, ...(embedding ? { embedding } : {}) })
    .select("id, title, summary, tags, category").single();
  if (error) return new Response("db error: " + error.message, { status: 500, headers: CORS });
  return Response.json({ ...data, url: APP + "#" + data.id }, { status: 201, headers: CORS });
});
