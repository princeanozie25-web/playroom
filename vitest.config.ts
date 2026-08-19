import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * TEST FILES RUN ONE AT A TIME, because they share one database.
     *
     * Vitest runs files in parallel by default. Every integration test in this repo talks to
     * the same Postgres, and most of them are safe about it — they create a uniquely-named room
     * and delete it afterwards, so their writes cannot collide.
     *
     * SOME STATE IS NOT ROOM-SCOPED and cannot be made so. A route's status, a member's
     * enrolment, the seeded roster: these are single rows describing the whole system. A test
     * that needs to observe "this member has no usable route" has to set that row, and while it
     * is set every other file sees it too. S1.1c's route tests exposed exactly that — three
     * unrelated tests in other files failed in the full run and passed individually, which is
     * the worst shape a failure can have: it looks like flakiness and it is a real ordering
     * dependency.
     *
     * The alternatives were worse. Weakening the assertions that enumerate members would have
     * removed the checks that catch a roster changing by accident, which is most of what
     * S1.1a and S1.1b are for. Inventing per-test databases is a real answer and a much larger
     * change than this slice should make.
     *
     * COST: wall-clock. The suite's tests take ~30s of work; serialising trades a little
     * concurrency for the removal of a whole class of cross-file interference. Correctness of
     * the signal beats the clock in a suite whose job is to be believed.
     */
    fileParallelism: false,
    // Browser journeys are owned by Playwright. Without this explicit boundary Vitest tries to
    // collect Playwright's serial suite and fails before either runner can provide a useful result.
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
  },
});
