export interface PullRequest {
  repository: string;
  title: string;
  number: number;
  prUrl: string,
  author: string,
  createdAt: number,
  avatarUrl: string;
  approvedBy: string[];
  changesRequestedBy: string[];
  commentedBy: string[];
  pendingReviews: string[];
  statusState: 'passed'|'pending'|'failed';
  actionable: boolean;
  actionMsg: string|null;
}

export interface DashResponse {
  prs: PullRequest[];
}
