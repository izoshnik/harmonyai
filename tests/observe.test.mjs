import test from 'node:test';
import assert from 'node:assert/strict';
import { newErrorCode, serviceErrorText, ERROR_CODE_RE, estimateCostUsd, providerOf, classifyError, isBlockedProfile, allowsTextLogging } from '../lib/observe.js';

test('error codes are unique 16-char tokens without look-alike symbols', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = newErrorCode();
    assert.match(c, /^[A-Za-z0-9]{16}$/);
    assert.doesNotMatch(c, /[0O1lI]/);
    seen.add(c);
  }
  assert.equal(seen.size, 2000);
});

test('service error text carries the code and the client regex finds it', () => {
  const t = serviceErrorText('Ueo18dkaoKfdk281');
  assert.equal(t, 'Ошибка сервиса № Ueo18dkaoKfdk281');
  assert.equal(ERROR_CODE_RE.exec(t + '. Попробуйте ещё раз.')[1], 'Ueo18dkaoKfdk281');
});

test('cost estimate: free models are zero, known models priced per million tokens', () => {
  assert.equal(estimateCostUsd({ upstream: 'nvidia/nemotron-3.5-super-vl:free', inputTokens: 1e6, outputTokens: 1e6 }), 0);
  assert.ok(Math.abs(estimateCostUsd({ upstream: 'deepseek-v4-flash', inputTokens: 1e6, outputTokens: 1e6 }) - 0.273) < 1e-9);
  assert.equal(estimateCostUsd({ upstream: 'unknown-model', inputTokens: 1e6 }), 0);
  assert.equal(estimateCostUsd({ upstream: 'gpt-image-2', unit: 'image' }), 0.04);
});

test('provider detection and error kinds', () => {
  assert.equal(providerOf('glm-5.3-flash'), 'pro-ai');
  assert.equal(providerOf('z-ai/glm-5.3-flash'), 'openrouter');
  assert.equal(providerOf('seedance-1.5-pro'), 'closerouter');
  assert.equal(classifyError(504, ''), 'timeout');
  assert.equal(classifyError(503, 'Model overloaded'), 'unavailable');
  assert.equal(classifyError(429, ''), 'quota');
  assert.equal(classifyError(0, 'fetch failed'), 'network');
});

test('blocked profile and text logging consent', () => {
  assert.equal(isBlockedProfile({ blocked_at: '2026-11-02T00:00:00Z' }), true);
  assert.equal(isBlockedProfile({ blocked_at: null }), false);
  assert.equal(allowsTextLogging({ settings: { ai_training: false } }), false);
  assert.equal(allowsTextLogging({ settings: {} }), true);
});
