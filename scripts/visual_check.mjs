import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const outputDir = fileURLToPath(new URL('../.qa/', import.meta.url))
await mkdir(outputDir, { recursive: true })

const browser = await chromium.launch()
const checks = []
for (const [name, viewport] of Object.entries({ desktop: { width: 1440, height: 1050 }, mobile: { width: 390, height: 844 } })) {
  const page = await browser.newPage({ viewport })
  const consoleErrors = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'networkidle' })
  await page.getByText('Total revenue', { exact: true }).waitFor()
  const revenueBefore = await page.locator('.metric-card strong').first().textContent()
  const categoryPanel = page.locator('.chart-panel').filter({ has: page.getByRole('heading', { name: 'Sales by category' }) })
  await categoryPanel.locator('.recharts-rectangle').first().click()
  await page.waitForFunction((previous) => document.querySelector('.metric-card strong')?.textContent !== previous, revenueBefore)
  const categoryFromChart = await page.locator('select').nth(1).inputValue()
  if (!categoryFromChart) throw new Error('Clicking a category bar did not set the category filter.')
  await categoryPanel.locator('.recharts-wrapper').hover()
  if (await page.locator('.recharts-tooltip-cursor').count()) throw new Error('Chart hover cursor overlay is still present.')
  if (viewport.width < 760) await page.getByTitle('Toggle filters').click()
  await page.locator('select').nth(1).selectOption('Burgers')
  await page.waitForFunction((previous) => document.querySelector('.metric-card strong')?.textContent !== previous, revenueBefore)
  const revenueAfter = await page.locator('.metric-card strong').first().textContent()
  if (revenueBefore === revenueAfter) throw new Error('Category filtering did not update the dashboard metrics.')
  await page.screenshot({ path: join(outputDir, `${name}-live.png`), fullPage: true })
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }))
  checks.push({ name, dimensions, categoryFromChart, filtered: revenueBefore !== revenueAfter, consoleErrors })
  await page.close()
}
await browser.close()
console.log(JSON.stringify(checks))
