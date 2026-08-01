import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('incident design keeps the six required environment values documented', () => {
  const design = fs.readFileSync('./INCIDENT-DESIGN.md', 'utf8');
  const heading = '## Required environment';
  const headingIndex = design.indexOf(heading);
  assert.notEqual(headingIndex, -1, 'required environment heading must be documented');
  const sectionStart = headingIndex + heading.length;
  const nextHeading = design.indexOf('\n## ', sectionStart);
  const requiredSection = design.slice(
    sectionStart,
    nextHeading === -1 ? design.length : nextHeading,
  );
  const lines = new Set(requiredSection.split(/\r?\n/));

  for (const name of [
    'DISCORD_BOT_TOKEN',
    'DISCORD_CLIENT_ID',
    'DISCORD_GUILD_ID',
    'OWNER_ID',
    'RUNNER_TOKEN_SECRET',
    'LOG_WEBHOOK_URL',
  ]) {
    assert.ok(lines.has(`${name}=`), `${name} must be documented as a required environment value`);
  }
});

test('incident design preserves Render logs and restricts webhook context', () => {
  const design = fs.readFileSync('./INCIDENT-DESIGN.md', 'utf8');
  assert.match(design, /Render\/Console logs/);
  assert.match(design, /Allowlist/);
  assert.match(design, /Controlled UAT/);
});
