# ai-inbox-triage — README Faz 5'te yazılacak.

<!-- EVAL:START -->
### Evaluation results

| Provider | Model | Category accuracy, mean (min–max) | Exact fields | Flexible fields | Prompt injection passed | Avg latency | Eval date |
|---|---|---|---|---|---|---|---|
| ollama | `qwen3.5:9b` | 98.3% (98.3%–98.3%) | 95.6% | 73.3% | 12/12 | 1873 ms | 2026-09-29 |
| gemini | – | Gemini path implemented (AI_PROVIDER=gemini) but not benchmarked. | – | – | – | – | – |

Flexible match: need/topic count as correct when their word sets (stopwords removed) overlap by Jaccard ≥ 0.5; budget/timeline when the normalized text or the set of numbers in it is equal. Full report: [eval/report.md](eval/report.md).
<!-- EVAL:END -->
