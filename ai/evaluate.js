// Owner: Нурлат. Contract in shared/schemas.md.
// Builds the prompt from the checklist version (never hardcode criteria), calls the provider,
// validates the answer (ids exist, scale value allowed, N/A only if na_allowed), retries once.

/**
 * @returns {Promise<{results: object[], calls: object[]}>}
 */
export async function evaluateConversation(conversation, criteria, checklistMeta) {
  throw new Error('evaluateConversation: not implemented yet');
}
