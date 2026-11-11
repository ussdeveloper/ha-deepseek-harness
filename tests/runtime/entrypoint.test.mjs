/**
 * Unit tests for entrypoint helpers (no container, no network).
 *
 * Run directly: node tests/runtime/entrypoint.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

const entrypoint = await import('../../deepseek_harness/rootfs/opt/ha-dsh/runtime/entrypoint.mjs')

test('extractApiKeyFromConfiguration reads the deepseek_harness block', () => {
  const yaml = [
    'default_config:',
    '',
    'deepseek_harness:',
    '  api_key: sk-1234567890abcdef',
    '',
    'automation: !include automations.yaml',
  ].join('\n')
  assert.equal(entrypoint.extractApiKeyFromConfiguration(yaml), 'sk-1234567890abcdef')
})

test('extractApiKeyFromConfiguration handles quotes and comments', () => {
  const yaml = ['deepseek_harness:', '  # managed by hand', '  api_key: "sk-abcdef123456"   # test key', ''].join('\n')
  assert.equal(entrypoint.extractApiKeyFromConfiguration(yaml), 'sk-abcdef123456')
})

test('extractApiKeyFromConfiguration accepts alternative key names', () => {
  const yaml = ['deepseek_harness:', '  deepseek_api_key: sk-alt-12345678', '  model: deepseek-chat'].join('\n')
  assert.equal(entrypoint.extractApiKeyFromConfiguration(yaml), 'sk-alt-12345678')
})

test('normalizeDeepSeekBaseUrl appends the Anthropic path to the vendor root', () => {
  assert.equal(entrypoint.normalizeDeepSeekBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com/anthropic')
  assert.equal(entrypoint.normalizeDeepSeekBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/anthropic')
  assert.equal(
    entrypoint.normalizeDeepSeekBaseUrl('https://api.deepseek.com/anthropic/'),
    'https://api.deepseek.com/anthropic',
  )
  assert.equal(entrypoint.normalizeDeepSeekBaseUrl('https://proxy.example.test/v1'), 'https://proxy.example.test/v1')
  assert.equal(entrypoint.normalizeDeepSeekBaseUrl(''), '')
})

test('extractApiKeyFromConfiguration accepts api: as the key name', () => {
  const yaml = ['deepseekharness:', '  api: sk-live12345678'].join('\n')
  assert.equal(entrypoint.extractApiKeyFromConfiguration(yaml), 'sk-live12345678')
})

test('extractApiKeyFromConfiguration accepts the underscore-less block form', () => {
  const yaml = ['default_config:', 'deepseekharness:', '  api_key: sk-nounderscore123'].join('\n')
  assert.equal(entrypoint.extractApiKeyFromConfiguration(yaml), 'sk-nounderscore123')
})

test('extractApiKeyFromConfiguration accepts an inline mapping', () => {
  const yaml = ['deepseekharness: {api_key: sk-inline12345}'].join('\n')
  assert.equal(entrypoint.extractApiKeyFromConfiguration(yaml), 'sk-inline12345')
})

test('extractApiKeyFromConfiguration ignores other integrations and empty values', () => {
  const yaml = [
    'deepseek_harness:',
    '  api_key: ""',
    '  base_url: https://api.deepseek.com',
    'other:',
    '  api_key: sk-not-ours',
  ].join('\n')
  assert.equal(entrypoint.extractApiKeyFromConfiguration(yaml), undefined)
})

test('extractApiKeyFromConfiguration does not read keys from unrelated blocks', () => {
  const yaml = ['http:', '  api_key: sk-wrong', 'deepseek_harness:', '  model: x'].join('\n')
  assert.equal(entrypoint.extractApiKeyFromConfiguration(yaml), undefined)
})
