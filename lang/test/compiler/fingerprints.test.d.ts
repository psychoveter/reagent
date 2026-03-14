/**
 * M8a Fingerprint E2E Tests
 *
 * F1: Compile same source twice → identical hashes
 * F2: Change one char in zone body → implHash differs, structureHash unchanged
 * F3: Add a new message step → structureHash differs → MAJOR bump
 * F4: Change only zone body → PATCH bump
 * F5: Protocol with invokes → dependencies array populated
 * F6: Compile → lock written. Fresh compile reading lock → same versions
 */
export {};
