#!/usr/bin/env node
// Temporary known-risk baseline, NOT a vulnerability fix.
// This enforces no additional vulnerable packages or increases above the
// measured production baseline on 2026-11-17, while surfacing all findings.
import { readFileSync, appendFileSync } from 'node:fs'

const accepted = new Set([
  'body-parser', 'form-data', 'lodash', 'matrix-bot-sdk', 'morgan',
  'nanoid', 'postcss', 'proxy-addr', 'qs', 'request',
  'request-promise', 'request-promise-core', 'sanitize-html',
  'source-map-js', 'tough-cookie', 'uuid',
])
const maximum = { critical: 3, high: 5, moderate: 8, low: 0 }
let report
try { report = JSON.parse(readFileSync(process.argv[2], 'utf8')) }
catch (err) {
  console.error('npm audit report missing or invalid:', err)
  process.exit(1)
}
if (!report.vulnerabilities || !report.metadata?.vulnerabilities) {
  console.error('npm audit did not return usable vulnerability metadata')
  process.exit(1)
}
const newVulnerabilities = Object.keys(report.vulnerabilities).filter(name => !accepted.has(name))
const counts = report.metadata.vulnerabilities
const increased = Object.entries(maximum).filter(([severity, count]) => (counts[severity] ?? 0) > count)
const summary = [
  '### Dependency security audit — known vulnerable baseline',
  '',
  '| Severity | Found | Baseline maximum |',
  '| --- | ---: | ---: |',
  ...Object.entries(maximum).map(([severity, max]) => '| ' + severity + ' | ' + (counts[severity] ?? 0) + ' | ' + max + ' |'),
  '',
  'This job **does not mean dependencies are safe**. The existing legacy matrix-bot-sdk request stack includes vulnerabilities without fixes. The hardening PR must remain draft until migration or remediation is complete.',
  '',
  'New vulnerable packages: ' + (newVulnerabilities.join(', ') || 'none'),
]
const msg = summary.join('\n')
console.log(msg)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, msg + '\n')
console.log('::warning::Production dependency vulnerabilities remain: ' + JSON.stringify(counts))
if (newVulnerabilities.length || increased.length) {
  console.error('New vulnerability or severity-count regression detected:', newVulnerabilities, increased)
  process.exit(1)
}
