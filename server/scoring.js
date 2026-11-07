// Owner: Азамат. Pure functions, no LLM. Rules from the official checklist:
// yes = full weight, no = 0, scale = value / max(scale) * weight;
// N/A excluded and its weight redistributed so the max stays 100; round to 2 decimals;
// no applicable weighted criteria -> total = null; gross error (c08) is a separate flag.
