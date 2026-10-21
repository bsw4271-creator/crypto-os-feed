import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWhales, largeTransfers } from '../lib/whales.mjs';

const W = '0x4adf44961a7cbe8ee46b2bf04e7198e879677825';
const EX = '0xdfd5293d8e347dfe59e90efd55b2956a1343963d';
const wallets = { exchanges: [{ address: EX, label: 'Binance 16' }], watch: [{ address: W, label: 'Galaxy' }] };
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const t0 = 1_800_000_000;
const tok = (o) => ({ hash: '0x1', timeStamp: String(t0 + 60), contractAddress: USDT, tokenDecimal: '6', from: W, to: EX, value: String(2_000_000 * 1e6), ...o });

test('whales: large USDT to an exchange is labelled; small, fake-token, out-of-window and failed rows are dropped', () => {
  const r = largeTransfers({
    wallets,
    prices: { ETHUSDT: 4000 },
    fromSec: t0,
    toSec: t0 + 3600,
    rows: [
      { wallet: W, kind: 'token', items: [tok(), tok({ hash: '0x2', value: String(10 * 1e6) }), tok({ hash: '0x3', contractAddress: '0xfake' }), tok({ hash: '0x4', timeStamp: String(t0 - 10) })] },
      { wallet: W, kind: 'eth', items: [{ hash: '0x5', timeStamp: String(t0 + 120), from: '0xabc', to: W, value: String(500n * 10n ** 18n), isError: '0' }, { hash: '0x6', timeStamp: String(t0 + 130), from: W, to: EX, value: String(500n * 10n ** 18n), isError: '1' }] },
    ],
  });
  assert.equal(r.transfers.length, 2);
  const [eth, usdt] = r.transfers;
  assert.deepEqual([usdt.kind, usdt.counterparty_label, usdt.usd, usdt.direction], ['to_exchange', 'Binance 16', 2_000_000, 'out']);
  assert.deepEqual([eth.kind, eth.asset, eth.usd, eth.direction], ['other', 'ETH', 2_000_000, 'in']);
  assert.equal(r.to_exchange_usd, 2_000_000);
  assert.equal(r.from_exchange_usd, 0);
});

test('whales: ETH without a price is skipped rather than guessed', () => {
  const r = largeTransfers({ wallets, prices: {}, fromSec: t0, toSec: t0 + 3600, rows: [{ wallet: W, kind: 'eth', items: [{ hash: '0x5', timeStamp: String(t0 + 1), from: EX, to: W, value: String(10n ** 22n) }] }] });
  assert.equal(r.transfers.length, 0);
});

test('whales: no key reports an error; API errors never include the key', async () => {
  const none = await fetchWhales({ wallets, prices: {}, fromSec: t0, toSec: t0 + 1, key: '' });
  assert.deepEqual(none.errors, ['ETHERSCAN_API_KEY not set']);
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ status: '0', message: 'NOTOK', result: 'Invalid API Key' }) };
  };
  const r = await fetchWhales({ wallets, prices: {}, fromSec: t0, toSec: t0 + 1, key: 'SECRETKEY', fetchImpl: fake, sleep: async () => {} });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((u) => u.includes('chainid=1')));
  assert.equal(r.errors.length, 3);
  assert.ok(r.errors.every((e) => !e.includes('SECRETKEY') && e.includes('Invalid API Key')));
});

test('whales: empty results are fine and full pages are flagged', async () => {
  const fake = async (url) => ({
    ok: true,
    json: async () => (url.includes('getblocknobytime') ? { status: '1', result: '123' } : url.includes('txlist') ? { status: '0', message: 'No transactions found', result: [] } : { status: '1', result: Array.from({ length: 1000 }, () => tok({ value: '1' })) }),
  });
  const r = await fetchWhales({ wallets, prices: {}, fromSec: t0, toSec: t0 + 3600, key: 'k', fetchImpl: fake, sleep: async () => {} });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /1000-row page full/);
  assert.equal(r.transfers.length, 0);
});
