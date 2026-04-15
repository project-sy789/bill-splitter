#!/usr/bin/env node
// Generates simple PWA icons (192x192 and 512x512) using Canvas API via @napi-rs/canvas
// Run: node scripts/gen-icons.cjs

const { createCanvas } = require('@napi-rs/canvas')
const fs = require('fs')
const path = require('path')

function drawIcon(size) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')

  // Background gradient (violet)
  const grad = ctx.createLinearGradient(0, 0, size, size)
  grad.addColorStop(0, '#7C3AED')
  grad.addColorStop(1, '#4F46E5')
  ctx.fillStyle = grad

  // Rounded rect
  const r = size * 0.2
  ctx.beginPath()
  ctx.moveTo(r, 0)
  ctx.lineTo(size - r, 0)
  ctx.arcTo(size, 0, size, r, r)
  ctx.lineTo(size, size - r)
  ctx.arcTo(size, size, size - r, size, r)
  ctx.lineTo(r, size)
  ctx.arcTo(0, size, 0, size - r, r)
  ctx.lineTo(0, r)
  ctx.arcTo(0, 0, r, 0, r)
  ctx.closePath()
  ctx.fill()

  // Receipt emoji
  ctx.font = `${size * 0.52}px serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('🧾', size / 2, size / 2 + size * 0.04)

  return canvas.toBuffer('image/png')
}

const outDir = path.join(__dirname, '../public')
fs.writeFileSync(path.join(outDir, 'icon-192.png'), drawIcon(192))
fs.writeFileSync(path.join(outDir, 'icon-512.png'), drawIcon(512))
console.log('Icons generated ✓')
