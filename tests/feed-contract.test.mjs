import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runOfflineFeed } from './helpers/feed-runner.mjs';

const entry = fileURLToPath(new URL('../feed.mjs', import.meta.url));
for (const mode of ['observed', 'empty', 'unavailable']) test(`real generator serializes ${mode} observations with JSON/Markdown UNKNOWN parity and no extra requests`, () => {
  const { feed, markdown, calls } = runOfflineFeed(entry, mode), whales = feed.flows.whales;
  assert.equal(feed.schema_version, 1);
  assert.equal(whales.verification.status, 'UNKNOWN');
  assert.equal(whales.verification.positive_confirmation_allowed, false);
  assert.deepEqual(calls, { binance: 5, hyperliquid: 2, stablecoins: 1, etherscan: 3, denied: 0 });
  assert.match(markdown, /위험 검사 UNKNOWN/); assert.match(markdown, /판정 불가/);
  assert.equal(whales.transfers.length, mode === 'observed' ? 7 : 0);
  assert.deepEqual(whales.verification.counts, { CHECKED: 0, UNKNOWN: whales.transfers.length, EXCLUDED: 0 });
  for (const [i, transfer] of whales.transfers.entries()) {
    assert.equal(transfer.verification.status, 'UNKNOWN'); assert.equal(transfer.verification.positive_confirmation_allowed, false);
    assert.match(markdown.split('\n').find(line => line.includes(`관측 #${i + 1}:`)), /위험 검사 UNKNOWN/);
  }
  if (mode === 'empty') assert.equal(whales.verification.reason, 'NO_OBSERVATIONS_IN_WINDOW');
  if (mode === 'unavailable') assert.equal(whales.verification.reason, 'OBSERVATIONS_UNAVAILABLE');
});
