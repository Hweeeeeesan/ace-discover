import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="simple-page">
      <div>
        <h1>Profile not found</h1>
        <p>This profile may have been removed or the link is incorrect.</p>
        <Link className="primary-button inline-flex" href="/">Back to discovery</Link>
      </div>
    </main>
  );
}
