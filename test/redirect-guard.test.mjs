/**
 * Every outbound call carries the Advertiser API key. Following a redirect would
 * forward that key to whatever host the redirect names, so no fetch in this
 * codebase may omit `redirect: "error"`, and no host other than the API may appear.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { isPublicHttpsUrl, isRedirect } from "../src/http.ts";

function sourceFiles(dir = "src", acc = []) {
  for (const entry of readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
    if (entry.isDirectory()) sourceFiles(`${dir}/${entry.name}`, acc);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".json")) acc.push(`${dir}/${entry.name}`);
  }
  return acc;
}

test("every fetch refuses to follow redirects", () => {
  const offenders = [];
  let calls = 0;
  for (const file of sourceFiles()) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (let index = text.indexOf("fetch("); index !== -1; index = text.indexOf("fetch(", index + 1)) {
      calls++;
      // The options object of a fetch call ends at the first `});` that follows.
      const tail = text.slice(index, index + 1200);
      const end = tail.indexOf("});");
      const call = end === -1 ? tail : tail.slice(0, end);
      if (!call.includes('redirect: "error"')) offenders.push(`${file}:${text.slice(0, index).split("\n").length}`);
    }
  }
  assert.ok(calls > 0, "the scan found no fetch call, so it checks nothing");
  assert.deepEqual(offenders, [], `These fetch calls may follow a redirect and leak the key: ${offenders.join(", ")}`);
});

test("the only host this server can reach is the Advertiser API", () => {
  const hosts = new Set();
  for (const file of sourceFiles()) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const match of text.matchAll(/https:\/\/([a-z0-9.-]+)/gi)) {
      const host = match[1].replace(/\.$/, "");
      // Documentation links and server metadata are not call targets.
      if (["developers.openai.com", "www.getmcpads.com", "mcp.getmcpads.com", "github.com"].includes(host)) continue;
      hosts.add(host);
    }
  }
  assert.deepEqual([...hosts].sort(), ["api.ads.openai.com"], "A new outbound host appeared. That is a deliberate decision, not an accident.");
});

test("redirect responses are recognised without reading their Location", () => {
  assert.equal(isRedirect(new Response(null, { status: 302, headers: { location: "https://example.invalid/?token=secret" } })), true);
  assert.equal(isRedirect(new Response("{}")), false);
});

test("URLs handed to the provider must be public HTTPS", () => {
  for (const url of ["https://cdn.example.com/a.png", "https://images.example.org/path/a.webp?x=1"]) assert.equal(isPublicHttpsUrl(url), true, url);
  for (const url of ["http://cdn.example.com/a.png", "https://user:pw@example.com/a.png", "https://example.com/a.png#frag", "https://localhost/a.png", "https://127.0.0.1/a.png", "https://10.1.2.3/a.png", "https://172.16.0.1/a.png", "https://192.168.1.1/a.png", "https://169.254.169.254/latest/meta-data", "https://[::1]/a.png", "https://[fd00::1]/a.png", "https://metadata.google.internal/x", "https://2130706433/a.png", "https://intranet/a.png", "https://printer.local/a.png", "not a url"]) assert.equal(isPublicHttpsUrl(url), false, url);
});
