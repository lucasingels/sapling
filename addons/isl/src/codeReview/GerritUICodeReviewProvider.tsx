/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {GerritDiffSummary} from 'isl-server/src/gerrit/gerritCodeReviewProvider';
import type {ReactNode} from 'react';
import {GerritSubmitOperation} from '../operations/GerritSubmitOperation';
import type {Operation} from '../operations/Operation';
import type {Dag} from '../previews';
import type {CodeReviewSystem, CommitInfo, DiffId, DiffSummary, Hash} from '../types';
import type {UICodeReviewProvider} from './UICodeReviewProvider';
import type {SyncStatus} from './syncStatus';

import {Button} from 'isl-components/Button';
import {Icon} from 'isl-components/Icon';
import {Tooltip} from 'isl-components/Tooltip';
import {useAtomValue} from 'jotai';
import {useState} from 'react';
import {MS_PER_DAY} from 'shared/constants';
import serverAPI from '../ClientToServerAPI';
import {OSSCommitMessageFieldSchema} from '../CommitInfoView/OSSCommitMessageFieldsSchema';
import {t, T} from '../i18n';
import {showModal} from '../useModal';
import {allDiffSummaries, codeReviewProvider} from './CodeReviewInfo';
import './GerritBadge.css';

type GerritState = GerritDiffSummary['state'];

function iconForState(state: GerritState): string {
  if (state === 'MERGED') {
    return 'git-merge';
  }
  if (state === 'ABANDONED') {
    return 'git-pull-request-closed';
  }
  return 'git-pull-request';
}

function badgeClass(state: GerritState): string {
  if (state === 'MERGED') {
    return 'gerrit-diff-status-MERGED';
  }
  if (state === 'ABANDONED') {
    return 'gerrit-diff-status-ABANDONED';
  }
  return 'gerrit-diff-status-NEW';
}

function tooltipForSummary(summary: GerritDiffSummary): string {
  if (summary.state === 'MERGED') {
    return t('Merged on Gerrit');
  }
  if (summary.state === 'ABANDONED') {
    return t('Abandoned on Gerrit');
  }
  return t('Open on Gerrit');
}

export class GerritUICodeReviewProvider implements UICodeReviewProvider {
  name = 'gerrit';
  label = t('Gerrit');

  constructor(public system: CodeReviewSystem & {type: 'gerrit'}) {}

  DiffBadgeContent({
    diff,
    children,
  }: {
    diff?: DiffSummary;
    children?: ReactNode;
    syncStatus?: SyncStatus;
  }): JSX.Element | null {
    if (diff != null && diff.type !== 'gerrit') {
      return null;
    }
    const summary = diff as GerritDiffSummary | undefined;
    const className = summary ? badgeClass(summary.state) : 'gerrit-diff-status-NEW';
    const tooltip = summary ? tooltipForSummary(summary) : t('Click to open change in Gerrit');
    return (
      <div className="gerrit-diff-info">
        <div className={`gerrit-diff-status ${className}`}>
          <Tooltip title={tooltip} delayMs={500}>
            {summary && (
              <Icon
                className="gerrit-diff-badge-icon"
                icon={iconForState(summary.state)}
              />
            )}
            {summary && <GerritStateLabel summary={summary} />}
            {children}
          </Tooltip>
        </div>
        {summary && summary.state === 'NEW' && <GerritReviewDecision summary={summary} />}
      </div>
    );
  }

  formatDiffNumber(diffId: DiffId, summary?: DiffSummary): string {
    const gerritSummary = summary as GerritDiffSummary | undefined;
    return gerritSummary?.number ? `#${gerritSummary.number}` : `#${diffId.substring(0, 8)}`;
  }

  getSyncStatuses(
    _commits: CommitInfo[],
    _allDiffSummaries: Map<string, DiffSummary>,
  ): Map<string, SyncStatus> {
    return new Map();
  }

  RepoInfo = () => {
    let host = '';
    let project = '';
    try {
      const parsed = new URL(this.system.remoteUrl);
      host = parsed.hostname;
      project = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
    } catch {}
    return (
      <span>
        {host}/{project}
      </span>
    );
  };

  getRemoteTrackingBranch(): string | null {
    return null;
  }

  getRemoteTrackingBranchFromDiffSummary(): string | null {
    return null;
  }

  isSplitSuggestionSupported(): boolean {
    return false;
  }

  submitOperation(_commits: Array<CommitInfo>, options?: {draft?: boolean}): Operation {
    return new GerritSubmitOperation(options);
  }

  submitCommandName(): string {
    return 'push';
  }

  getSupportedStackActions(
    _hash: Hash,
    _dag: Dag,
    _diffSummaries: Map<string, DiffSummary>,
  ): {resubmittableStack?: Array<CommitInfo>; submittableStack?: Array<CommitInfo>} {
    return {};
  }

  getSubmittableDiffs(
    _commits: Array<CommitInfo>,
    _allDiffSummaries: Map<string, DiffSummary>,
  ): CommitInfo[] {
    return [];
  }

  isDiffClosed(summary: DiffSummary): boolean {
    return (summary as GerritDiffSummary).state === 'ABANDONED';
  }

  isDiffEligibleForCleanup(summary: DiffSummary): boolean {
    const s = summary as GerritDiffSummary;
    return s.state === 'MERGED' || s.state === 'ABANDONED';
  }

  getUpdateDiffActions(_summary: DiffSummary) {
    return [];
  }

  commitMessageFieldsSchema = OSSCommitMessageFieldSchema;
  // Gerrit supports WIP state on any push, not just the first one
  supportSubmittingAsDraft = 'always' as const;
  supportsUpdateMessage = false;
  supportBranchingPrs = false;
  enableMessageSyncing = false;
  supportsSuggestedReviewers = false;
  supportsComparingSinceLastSubmit = false;
  supportsRenderingMarkup = false;
  gotoDistanceWarningAgeCutoff = 30 * MS_PER_DAY;
}

function GerritReviewDecision({summary}: {summary: GerritDiffSummary}) {
  const {codeReview, codeReviewAttribution} = summary;
  let className: string;
  let label: JSX.Element;
  if (codeReview === 'rejected') {
    className = 'gerrit-review-decision-rejected';
    label = <T>Rejected</T>;
  } else if (codeReview === 'disliked') {
    className = 'gerrit-review-decision-needs-work';
    label = <T>Needs Work</T>;
  } else if (codeReview === 'approved') {
    className = 'gerrit-review-decision-approved';
    label = <T>Approved</T>;
  } else if (codeReview === 'recommended') {
    className = 'gerrit-review-decision-recommended';
    label = <T>Recommended</T>;
  } else {
    className = 'gerrit-review-decision-required';
    label = <T>Review Required</T>;
  }
  const pill = <span className={`gerrit-review-decision ${className}`}>{label}</span>;
  if (codeReviewAttribution == null) {
    return pill;
  }
  return (
    <Tooltip title={codeReviewAttribution} delayMs={500}>
      {pill}
    </Tooltip>
  );
}

function GerritStateLabel({summary}: {summary: GerritDiffSummary}) {
  switch (summary.state) {
    case 'MERGED':
      return <T>Merged</T>;
    case 'ABANDONED':
      return <T>Abandoned</T>;
    default:
      return <T>Open</T>;
  }
}

/**
 * Top-bar button that appears when Gerrit has an auth error and disappears
 * once diffs load successfully. Completely self-contained — reads its own atoms.
 */
export function GerritSetupButton() {
  const provider = useAtomValue(codeReviewProvider);
  const summaries = useAtomValue(allDiffSummaries);

  if (provider?.name !== 'gerrit' || summaries.error == null) {
    return null;
  }

  const webUrl = provider.system.type === 'gerrit' ? (provider.system.webUrl ?? '') : '';

  return (
    <Tooltip title={t('Gerrit authentication required. Click to configure credentials.')} placement="bottom">
      <Button
        className="gerrit-setup-button"
        onClick={() =>
          showModal({
            type: 'custom',
            title: t('Configure Gerrit Credentials'),
            component: ({returnResultAndDismiss}) => (
              <GerritCredentialForm webUrl={webUrl} onDismiss={returnResultAndDismiss} />
            ),
          })
        }>
        <Icon icon="warning" slot="start" />
        <T>Gerrit</T>
      </Button>
    </Tooltip>
  );
}

export function GerritConfigureCredentialsButton({webUrl}: {webUrl: string}) {
  return (
    <Button
      onClick={() =>
        showModal({
          type: 'custom',
          title: t('Configure Gerrit Credentials'),
          component: ({returnResultAndDismiss}) => (
            <GerritCredentialForm webUrl={webUrl} onDismiss={returnResultAndDismiss} />
          ),
        })
      }>
      <T>Configure credentials</T>
    </Button>
  );
}

function GerritCredentialForm({
  webUrl,
  onDismiss,
}: {
  webUrl: string;
  onDismiss: (result: boolean) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setLoading(true);
    setError(null);
    serverAPI.postMessage({type: 'gerritSetCredentials', webUrl, username, password});
    const result = await serverAPI.nextMessageMatching('gerritCredentialsResult', () => true);
    if (result.success) {
      serverAPI.postMessage({type: 'fetchDiffSummaries'});
      onDismiss(true);
    } else {
      setError(result.error ?? t('Invalid credentials'));
      setLoading(false);
    }
  };

  return (
    <div className="gerrit-credential-form">
      <p>
        <T>Enter your Gerrit HTTP password to authenticate.</T>{' '}
        {webUrl && (
          <a href={`${webUrl}/settings/#HTTPCredentials`} target="_blank" rel="noreferrer">
            <T>Generate HTTP password</T>
          </a>
        )}
      </p>
      <div className="gerrit-credential-fields">
        <input
          placeholder={t('Username')}
          value={username}
          onChange={e => setUsername(e.target.value)}
          disabled={loading}
          autoFocus
        />
        <input
          type="password"
          placeholder={t('HTTP password')}
          value={password}
          onChange={e => setPassword(e.target.value)}
          disabled={loading}
          onKeyDown={e => e.key === 'Enter' && !loading && username && password && handleSubmit()}
        />
      </div>
      {error && <p className="gerrit-credential-error">{error}</p>}
      <div className="gerrit-credential-actions">
        <Button onClick={() => onDismiss(false)} disabled={loading}>
          <T>Cancel</T>
        </Button>
        <Button
          kind="primary"
          onClick={handleSubmit}
          disabled={loading || !username || !password}>
          {loading ? <T>Verifying...</T> : <T>Save</T>}
        </Button>
      </div>
    </div>
  );
}

