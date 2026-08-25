import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const outputDir = fileURLToPath(new URL('../.qa/', import.meta.url))
await mkdir(outputDir, { recursive: true })

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
await page.route('**/api/**', async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 1800))
  await route.continue()
})
await page.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' })
await page.locator('.dashboard-skeleton').waitFor()
const footerCount = await page.locator('.app-footer').count()
await page.screenshot({ path: join(outputDir, 'loading-state.png'), fullPage: true })
if (footerCount !== 0) throw new Error('Footer should not render while the dashboard is loading.')
console.log(JSON.stringify({ skeletonVisible: true, footerCount }))
await browser.close()
