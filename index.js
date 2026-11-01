/**
 * Host half of the quote-annotate bundle.
 *
 * Deliberately inert: the whole feature lives in the browser (./client.js).
 * This entry exists so the Loader mounts the package and its `dsh.client`
 * declaration reaches the Web client runtime.
 */
export function apply() {}
