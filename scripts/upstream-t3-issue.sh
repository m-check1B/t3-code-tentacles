#!/usr/bin/env bash
# One GitHub issue per failing upstream T3 tag (upstream-t3-stable.yml).
# Env: GH_TOKEN, GITHUB_REPOSITORY, TAG, RUN_URL. A match in any state is
# reopened if closed and commented; only when nothing matches is one created.
set -euo pipefail
title="Upstream T3 Code ${TAG:-unknown} fails the Tentacles stock smoke"
api="https://api.github.com/repos/$GITHUB_REPOSITORY/issues"
query=$(TITLE="$title" REPO="$GITHUB_REPOSITORY" node -e 'process.stdout.write(encodeURIComponent(`repo:${process.env.REPO} is:issue in:title "${process.env.TITLE}"`))')
match=$(curl -fsSL -H "Authorization: Bearer $GH_TOKEN" "https://api.github.com/search/issues?q=$query&per_page=100" | TITLE="$title" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s).items.find(i=>i.title===process.env.TITLE);process.stdout.write(i?`${i.number} ${i.state}`:"")})')
if [ -n "$match" ]; then
  number=${match%% *}; state=${match#* }
  comment=$(RUN_URL="$RUN_URL" node -e 'process.stdout.write(JSON.stringify({body:`Failed again: ${process.env.RUN_URL}`}))')
  if [ "$state" = "closed" ]; then curl -fsSL -X PATCH -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/json" "$api/$number" -d '{"state":"open"}' > /dev/null; fi
  curl -fsSL -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/json" "$api/$number/comments" -d "$comment" > /dev/null
  echo "::error title=$title::issue #$number ($state, now open) updated"
else
  body=$(TITLE="$title" RUN_URL="$RUN_URL" node -e 'process.stdout.write(JSON.stringify({title:process.env.TITLE,body:`The scheduled stock-T3 smoke failed.\n\nRun: ${process.env.RUN_URL}\n\nDo not widen the range in src/t3-support.mjs until this passes. Customers on T3 auto-update may already run this release: check Tentacles doctor t3.support and t3.talk on one Mac.`}))')
  curl -fsSL -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Content-Type: application/json" "$api" -d "$body" > /dev/null
  echo "::error title=$title::opened issue"
fi
