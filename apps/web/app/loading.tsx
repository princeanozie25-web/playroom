export default function Loading() {
  return (
    <main className="route-loading" role="status" aria-live="polite" aria-label="Loading Playroom">
      <span className="route-loading__mark" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      <span>Preparing the room</span>
    </main>
  );
}
