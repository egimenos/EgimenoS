#!/usr/bin/env node
// Generates the profile cards in cards/ from the GitHub GraphQL API.
//
// Usage: GH_TOKEN=<token> node scripts/generate-cards.mjs
//
// The token needs the `repo` scope so private repositories are counted.
// Only aggregates (counts and language shares) end up in the SVGs.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'cards');

// Markup languages say little about the kind of work, so they are left out.
const EXCLUDED_LANGUAGES = new Set(['HTML', 'CSS']);
const MAX_LANGUAGES = 5;

// Solarized light, matching the github-profile-summary-cards theme in the README.
const THEME = {
  background: '#fdf6e3',
  title: '#268bd2',
  text: '#586e75',
  icon: '#b58900',
  track: '#eee8d5',
  other: '#93a1a1',
};

const WIDTH = 340;
const HEIGHT = 200;
const FONT = `'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif`;

// Octicons, 16x16.
const ICONS = {
  mark: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z',
  commit: 'M10.5 7.75a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.43.75a4.002 4.002 0 01-7.86 0H.75a.75.75 0 110-1.5h3.32a4.001 4.001 0 017.86 0h3.32a.75.75 0 110 1.5h-3.32z',
  pullRequest: 'M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z',
  issue: 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm9 3a1 1 0 11-2 0 1 1 0 012 0zm-.25-6.25a.75.75 0 00-1.5 0v3.5a.75.75 0 001.5 0v-3.5z',
  repo: 'M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z',
};

const LANGUAGES_FRAGMENT = `
  languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
    edges { size node { name color } }
  }`;

async function graphql(query, variables = {}) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${process.env.GH_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-cards',
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (!response.ok || body.errors) {
    throw new Error(`GitHub API error: ${JSON.stringify(body.errors ?? body)}`);
  }
  return body.data;
}

// contributionsCollection spans at most one year, so all-time totals need one alias per year.
function yearlyContributionAliases(firstYear, now) {
  const aliases = [];
  for (let year = firstYear; year <= now.getUTCFullYear(); year++) {
    const from = `${year}-01-01T00:00:00Z`;
    const endOfYear = new Date(`${year}-12-31T23:59:59Z`);
    const to = (endOfYear < now ? endOfYear : now).toISOString();
    aliases.push(`y${year}: contributionsCollection(from: "${from}", to: "${to}") {
      totalCommitContributions
      contributionCalendar { totalContributions }
    }`);
  }
  return aliases.join('\n');
}

async function fetchOwnedRepositories() {
  const repositories = [];
  let cursor = null;
  do {
    const { viewer } = await graphql(
      `query ($cursor: String) {
        viewer {
          repositories(ownerAffiliations: OWNER, isFork: false, first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { ${LANGUAGES_FRAGMENT} }
          }
        }
      }`,
      { cursor },
    );
    repositories.push(...viewer.repositories.nodes);
    cursor = viewer.repositories.pageInfo.hasNextPage ? viewer.repositories.pageInfo.endCursor : null;
  } while (cursor);
  return repositories;
}

async function fetchData() {
  const now = new Date();
  const { viewer: account } = await graphql('query { viewer { createdAt } }');
  const firstYear = new Date(account.createdAt).getUTCFullYear();

  const { viewer } = await graphql(`query {
    viewer {
      pullRequests { totalCount }
      issues { totalCount }
      ${yearlyContributionAliases(firstYear, now)}
      lastYear: contributionsCollection {
        commitContributionsByRepository(maxRepositories: 100) {
          contributions { totalCount }
          repository { ${LANGUAGES_FRAGMENT} }
        }
      }
    }
  }`);

  const years = Object.keys(viewer)
    .filter((key) => /^y\d{4}$/.test(key))
    .map((key) => viewer[key]);

  return {
    totalContributions: sum(years.map((year) => year.contributionCalendar.totalContributions)),
    totalCommits: sum(years.map((year) => year.totalCommitContributions)),
    totalPullRequests: viewer.pullRequests.totalCount,
    totalIssues: viewer.issues.totalCount,
    commitsByRepository: viewer.lastYear.commitContributionsByRepository,
    repositories: await fetchOwnedRepositories(),
  };
}

const sum = (numbers) => numbers.reduce((total, n) => total + n, 0);

function countedLanguages(repository) {
  return repository.languages.edges.filter((edge) => !EXCLUDED_LANGUAGES.has(edge.node.name));
}

function addTo(totals, language, amount) {
  const entry = totals.get(language.name) ?? { name: language.name, color: language.color, value: 0 };
  entry.value += amount;
  totals.set(language.name, entry);
}

// Each repository counts once, under its largest non-excluded language.
function languagesByRepository(repositories) {
  const totals = new Map();
  for (const repository of repositories) {
    const [largest] = countedLanguages(repository);
    if (largest) addTo(totals, largest.node, 1);
  }
  return totals;
}

// The API does not say which files a commit touched, so each repository's commits
// are split across its languages in proportion to their size in the repository.
function languagesByCommit(commitsByRepository) {
  const totals = new Map();
  for (const { repository, contributions } of commitsByRepository) {
    const languages = countedLanguages(repository);
    const repositorySize = sum(languages.map((edge) => edge.size));
    for (const edge of languages) {
      addTo(totals, edge.node, (contributions.totalCount * edge.size) / repositorySize);
    }
  }
  return totals;
}

function topLanguages(totals) {
  const sorted = [...totals.values()].sort((a, b) => b.value - a.value);
  const total = sum(sorted.map((entry) => entry.value));
  const rows = sorted.slice(0, MAX_LANGUAGES).map((entry) => ({
    name: entry.name,
    color: entry.color ?? THEME.other,
    share: entry.value / total,
  }));
  const otherShare = sum(sorted.slice(MAX_LANGUAGES).map((entry) => entry.value)) / total;
  if (otherShare >= 0.005) rows.push({ name: 'Other', color: THEME.other, share: otherShare });
  return rows;
}

function formatShare(share) {
  const percent = share * 100;
  if (percent < 1) return '<1%';
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

const escapeXml = (text) =>
  String(text).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

function card(title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeXml(title)}">
<g font-family="${FONT}">
<rect x="1" y="1" rx="5" ry="5" width="${WIDTH - 2}" height="${HEIGHT - 2}" fill="${THEME.background}" stroke="${THEME.background}"/>
<text x="30" y="40" font-size="22" fill="${THEME.title}">${escapeXml(title)}</text>
${body}
</g>
</svg>
`;
}

function statsCard(rows) {
  const body = rows
    .map(({ icon, label, value }, index) => {
      const y = 60 + index * 25.2;
      return `<g transform="translate(30,${y.toFixed(1)})">
<path fill-rule="evenodd" fill="${THEME.icon}" d="${ICONS[icon]}"/>
<text x="21" y="13" font-size="14" fill="${THEME.text}">${escapeXml(label)}:</text>
<text x="170" y="13" font-size="14" font-weight="600" fill="${THEME.text}">${value.toLocaleString('en-US')}</text>
</g>`;
    })
    .join('\n');
  return card('Stats', body);
}

function languagesCard(title, subtitle, rows) {
  const barX = 118;
  const barWidth = 150;
  const body = rows
    .map(({ name, color, share }, index) => {
      const y = 82 + index * 20;
      const filled = Math.max(barWidth * share, 4);
      return `<text x="30" y="${y}" font-size="13" fill="${THEME.text}">${escapeXml(name)}</text>
<rect x="${barX}" y="${y - 9}" width="${barWidth}" height="8" rx="4" fill="${THEME.track}"/>
<rect x="${barX}" y="${y - 9}" width="${filled.toFixed(1)}" height="8" rx="4" fill="${color}"/>
<text x="310" y="${y}" font-size="13" text-anchor="end" fill="${THEME.text}">${escapeXml(formatShare(share))}</text>`;
    })
    .join('\n');
  return card(
    title,
    `<text x="30" y="58" font-size="12" fill="${THEME.text}">${escapeXml(subtitle)}</text>\n${body}`,
  );
}

async function main() {
  if (!process.env.GH_TOKEN) {
    throw new Error('GH_TOKEN is not set');
  }

  const data = await fetchData();
  const cards = {
    'stats.svg': statsCard([
      { icon: 'mark', label: 'Total Contributions', value: data.totalContributions },
      { icon: 'commit', label: 'Total Commits', value: data.totalCommits },
      { icon: 'pullRequest', label: 'Total PRs', value: data.totalPullRequests },
      { icon: 'issue', label: 'Total Issues', value: data.totalIssues },
      { icon: 'repo', label: 'Repositories', value: data.repositories.length },
    ]),
    'languages-by-repo.svg': languagesCard(
      'Top Languages by Repo',
      'all my repositories',
      topLanguages(languagesByRepository(data.repositories)),
    ),
    'languages-by-commit.svg': languagesCard(
      'Top Languages by Commit',
      'last 12 months',
      topLanguages(languagesByCommit(data.commitsByRepository)),
    ),
  };

  await mkdir(OUT_DIR, { recursive: true });
  for (const [name, svg] of Object.entries(cards)) {
    await writeFile(join(OUT_DIR, name), svg);
    console.log(`wrote cards/${name}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
