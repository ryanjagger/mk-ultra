/**
 * Debug auto-driver (enable with ?bot). The brain now lives in the sim
 * (`@mk/sim` botMask) because CPU seats use it deterministically; this
 * re-export keeps the ?bot client and time-trial bot on the same driver.
 * The mask goes through the exact same input path as the keyboard.
 */
export { botMask } from '@mk/sim';
