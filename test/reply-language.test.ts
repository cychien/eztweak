import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectLanguage, replyLanguageLine } from '../src/reply-language.js'

test('a comment names its language, and the Chinese script it is written in', () => {
  assert.equal(detectLanguage('變好看一點'), 'Traditional Chinese (繁體中文)')
  assert.equal(detectLanguage('变好看一点'), 'Simplified Chinese (简体中文)')
  assert.equal(
    detectLanguage('改好看'),
    'Traditional Chinese (繁體中文)',
    'shared characters: the shell',
  )
  assert.equal(detectLanguage('もっと大きく'), 'Japanese (日本語)', 'kana, even beside kanji')
  assert.equal(detectLanguage('더 크게'), 'Korean (한국어)')
  assert.equal(detectLanguage('make this button bigger'), 'English')
  assert.equal(detectLanguage('CTA'), null, 'too little to tell')
  assert.equal(detectLanguage('hazlo más grande'), null, 'Latin letters are not all English')
})

test('markers, code and links are not what the user wrote', () => {
  assert.equal(detectLanguage('[file 1] `const bigger = true` https://example.com/the/page'), null)
  assert.equal(detectLanguage('/explore 換個排法'), 'Traditional Chinese (繁體中文)')
})

test('the newest words that name a language decide, and the shell speaks for none', () => {
  assert.ok(
    replyLanguageLine(['CTA', '按鈕改藍']).includes('in Traditional Chinese (繁體中文), the'),
  )
  assert.ok(replyLanguageLine(['make it bigger', '按鈕改藍']).includes(' in English, '))
  assert.ok(
    replyLanguageLine(['hazlo más grande']).includes('- "hazlo más grande" - not the English'),
    'a language it cannot name is quoted',
  )
  assert.ok(replyLanguageLine([]).includes("Traditional Chinese (繁體中文), the review shell's"))
})
