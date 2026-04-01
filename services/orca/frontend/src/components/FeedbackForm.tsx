'use client';

import { useState } from 'react';
import { ThumbsUp, ThumbsDown, CheckCircle2 } from 'lucide-react';
import { submitFeedback } from '@/lib/api';

interface FeedbackFormProps {
  rcaId: string;
  initialRating?: 0 | 1 | null;
  initialComment?: string | null;
}

export function FeedbackForm({ rcaId, initialRating, initialComment }: FeedbackFormProps) {
  const [rating, setRating] = useState<0 | 1 | null>(initialRating ?? null);
  const [comment, setComment] = useState<string>(initialComment ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(initialRating !== null && initialRating !== undefined);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (rating === null) return;
    setSubmitting(true);
    setError(null);
    try {
      await submitFeedback(rcaId, { rating, comment: comment.trim() || null });
      setSubmitted(true);
    } catch {
      setError('Failed to submit feedback. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleRatingClick(value: 0 | 1) {
    setRating((prev) => (prev === value ? null : value));
    setSubmitted(false);
  }

  return (
    <div className="bg-card border border-border rounded-lg p-6">
      <div className="flex flex-col md:flex-row gap-8">
        {/* Left: question + vote buttons */}
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-semibold text-foreground">
            Was this RCA report helpful?
          </h3>
          <p className="text-sm text-muted-foreground mt-1 mb-5">
            Help us improve the Orca Agent by providing feedback on this analysis.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => handleRatingClick(1)}
              className={[
                'flex items-center gap-2 px-4 py-2 rounded-[6px] border text-sm font-medium transition-all',
                rating === 1
                  ? 'bg-emerald-50 border-success text-success'
                  : 'bg-background border-border text-foreground hover:border-success hover:text-success',
              ].join(' ')}
            >
              <ThumbsUp className="w-4 h-4 shrink-0" />
              Yes, Accurate
            </button>
            <button
              type="button"
              onClick={() => handleRatingClick(0)}
              className={[
                'flex items-center gap-2 px-4 py-2 rounded-[6px] border text-sm font-medium transition-all',
                rating === 0
                  ? 'bg-red-50 border-destructive text-destructive'
                  : 'bg-background border-border text-foreground hover:border-destructive hover:text-destructive',
              ].join(' ')}
            >
              <ThumbsDown className="w-4 h-4 shrink-0" />
              Needs Correction
            </button>
          </div>
        </div>

        {/* Right: textarea + submit */}
        <form onSubmit={handleSubmit} className="flex-1 min-w-0 flex flex-col gap-3">
          <label className="text-xs font-medium text-muted-foreground">
            Additional Feedback
          </label>
          <textarea
            value={comment}
            onChange={(e) => { setComment(e.target.value); setSubmitted(false); }}
            rows={4}
            placeholder="Tell us what we missed or what was particularly helpful…"
            className="w-full rounded-[6px] border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground resize-y focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary transition-colors"
          />

          {error && <p className="text-xs text-destructive">{error}</p>}

          {submitted ? (
            <div className="flex items-center gap-2 text-sm font-medium text-success">
              <CheckCircle2 className="w-4 h-4" />
              Feedback submitted — thank you!
            </div>
          ) : (
            <button
              type="submit"
              disabled={rating === null || submitting}
              className="w-full h-9 rounded-[6px] bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Submitting…' : 'Submit Feedback'}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
