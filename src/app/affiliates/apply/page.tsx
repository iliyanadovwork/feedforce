'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/app/hooks/useAuth';
import { authedFetch } from '@/lib/authedFetch';
import { AuthForm } from '@/app/components/AuthForm';
import { BrandLoader, Button, Card, EmptyState, WizardSteps } from '@/app/components/ui';
import { FeedForceLogo } from '@/app/components/Logo';
import { CheckIcon } from '@/lib/icons';
import { ApplicationForm, type ApplicationInput } from './ApplicationForm';

// Affiliate application flow (feedforce.ai/affiliates/apply): create an account (or sign in with an
// existing one), then submit the application form. Uses the SAME Supabase auth as regular FeedForce
// customers (useAuth) — just a dedicated entry point, not a separate auth system. Distinct from
// /affiliate (singular), the signed-in affiliate's OWN dashboard once approved.

type Application = {
  status: 'pending' | 'approved' | 'rejected';
  rejectReason: string | null;
};

function Shell({ children, showLogo = true }: { children: React.ReactNode; showLogo?: boolean }) {
  return (
    <div className="min-h-screen bg-page text-fg flex flex-col items-center px-4 py-16">
      <div className="w-full max-w-md flex flex-col items-center gap-6">
        {showLogo && <Link href="/affiliates"><FeedForceLogo className="h-8 w-auto" /></Link>}
        {children}
      </div>
    </div>
  );
}

export default function ApplyPage() {
  const router = useRouter();
  const { user, loading: authLoading, signIn, signUp, resetPassword } = useAuth();
  const [application, setApplication] = useState<Application | null | 'loading'>('loading');
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch('/api/affiliates/application');
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        setApplication(res.ok ? (json.application ?? null) : null);
      } catch {
        if (!cancelled) setApplication(null);
      }
    })();
    return () => { cancelled = true; };
  }, [authLoading, user]);

  async function submitApplication(data: ApplicationInput): Promise<string | null> {
    setSubmitError(null);
    try {
      const res = await authedFetch('/api/affiliates/application', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return json.error || 'Could not submit your application.';
      setApplication({ status: 'pending', rejectReason: null });
      return null;
    } catch {
      return 'Could not submit your application.';
    }
  }

  if (authLoading) {
    return <Shell showLogo={false}><BrandLoader size={56} /></Shell>;
  }

  if (!user) {
    return (
      <Shell>
        <WizardSteps steps={['Create account', 'Tell us about you']} current={0} />
        <Card surface={1} padding="md" className="w-full">
          <AuthForm
            initialMode="signup"
            onSignIn={signIn} onSignUp={signUp} onResetPassword={resetPassword}
            subtitle={{ login: 'Sign in to your affiliate account', signup: 'Create your affiliate account' }}
            maxWidthClassName="max-w-md"
          />
        </Card>
      </Shell>
    );
  }

  if (application === 'loading') {
    return <Shell showLogo={false}><BrandLoader size={56} /></Shell>;
  }

  if (application === null) {
    return (
      <Shell>
        <WizardSteps steps={['Create account', 'Tell us about you']} current={1} />
        <Card surface={1} padding="md" className="w-full flex justify-center">
          <ApplicationForm onSubmit={submitApplication} />
        </Card>
        {submitError && <p className="text-caption text-danger-text">{submitError}</p>}
      </Shell>
    );
  }

  if (application.status === 'pending') {
    return (
      <Shell>
        <Card surface={1} padding="md" className="w-full">
          <EmptyState title="Application submitted" description="We're reviewing it — you'll be able to sign in here once you're approved." />
        </Card>
      </Shell>
    );
  }

  if (application.status === 'approved') {
    return (
      <Shell>
        <Card surface={1} padding="md" className="w-full">
          <EmptyState
            icon={<CheckIcon size={22} className="text-fg" />}
            title="You're approved!"
            description="Your affiliate code and dashboard are ready."
            action={<Button variant="primary" size="sm" onClick={() => router.push('/affiliate')}>Go to your affiliate dashboard</Button>}
          />
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <Card surface={1} padding="md" className="w-full">
        <EmptyState
          tone="danger"
          title="Application not approved"
          description={application.rejectReason || "This application wasn't approved. Reach out if you have questions."}
        />
      </Card>
    </Shell>
  );
}
