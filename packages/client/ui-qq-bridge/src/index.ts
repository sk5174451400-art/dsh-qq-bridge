/**
 * @deepseek-ai/dsh-client-ui-qq-bridge — node half.
 *
 * The empty apply exists so the plugin appears in the host cordis.yml /
 * Loader; the browser half owns the settings card through exports["./client"],
 * discovered from the package.json dsh.client declaration.
 *
 * @module @deepseek-ai/dsh-client-ui-qq-bridge
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
