/*
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

import gql from 'graphql-tag';

import {getOrgRepos, getReviewsForPullRequest} from '../common';
import {GitHub} from '../../utils/github';
import {PullRequestCommitsQuery, PullRequestCommitsQueryVariables} from '../../types/gql-types';
import {RepoCommitsQuery, RepoCommitsQueryVariables} from '../../types/gql-types';
import {RepoPRsCommitsQuery, RepoPRsCommitsQueryVariables} from '../../types/gql-types';

import {MetricResult} from './metric-result';

export class ReviewCoverageResult implements MetricResult {
  commits: ReviewedCommit[];

  constructor(commits: ReviewedCommit[]) {
    this.commits = commits;
  }

  summary() {
    const count = this.numReviewed();
    return `There are ${this.commits.length} commits of which ` +
        `${count} are reviewed.\nReview coverage is ` +
        `${Math.round(count / this.commits.length * 100)}%.`;
  }

  rawData() {
    // TODO: Implement a raw API
    return this.summary();
  }

  numReviewed(): number {
    let numReviewed = 0;
    for (const commit of this.commits) {
      if (commit.reviewed) {
        numReviewed++;
      }
    }
    return numReviewed;
  }
}

type ReviewCoverageOpts = {
  org: string,
  repo?: string,
  since?: string,  // ISO date string
};

type Commit = {
  oid: string,
  committedDate: string,
};

type ReviewedCommit = Commit&{
  reviewed: boolean,
};

/**
 * Computes how much of an org/repository is reviewed.
 */
export async function getReviewCoverage(
    github: GitHub, opts: ReviewCoverageOpts): Promise<ReviewCoverageResult> {
  let repos;
  if (opts.repo) {
    repos = [{owner: opts.org, name: opts.repo}];
  } else {
    repos = await getOrgRepos(github, opts.org);
  }

  const commits = [];
  const reviewedCommits: Set<string> = new Set();
  for (const {owner, name} of repos) {
    // Fetched all reviewed commits.
    for (const commit of await getPRCommitsForRepo(github, owner, name)) {
      reviewedCommits.add(commit.oid);
    }

    // Get all commits on the master branch.
    for (const commit of await getMasterCommits(
             github, owner, name, opts.since)) {
      commits.push(
          Object.assign({reviewed: reviewedCommits.has(commit.oid)}, commit));
    }
  }

  return new ReviewCoverageResult(commits);
}

/**
 * Get all the commits on the default (normally master) branch for the last
 * year.
 */
async function getMasterCommits(
    github: GitHub, owner: string, name: string, since?: string):
    Promise<Commit[]> {
  const getPageInfo = (data: RepoCommitsQuery) => {
    if (!data.repository || !data.repository.defaultBranchRef ||
        data.repository.defaultBranchRef.target.__typename !== 'Commit') {
      return null;
    }
    return data.repository.defaultBranchRef.target.history;
  };
  const results =
      github.cursorQuery<RepoCommitsQuery, RepoCommitsQueryVariables>(
          repoCommitsQuery, {owner, name, since}, getPageInfo);

  const commits = [];
  for await (const data of results) {
    if (!data || !data.repository || !data.repository.defaultBranchRef) {
      continue;
    }
    if (data.repository.defaultBranchRef.target.__typename !== 'Commit') {
      throw new Error('Expected default branch ref to point to a commit.');
    }
    for (const commit of
             data.repository.defaultBranchRef.target.history.nodes ||
         []) {
      if (commit) {
        commits.push(commit);
      }
    }
  }
  return commits;
}

/**
 * Gets all the commits from reviewed pull requests in a repo.
 */
async function getPRCommitsForRepo(
    github: GitHub, owner: string, name: string): Promise<Commit[]> {
  const results =
      github.cursorQuery<RepoPRsCommitsQuery, RepoPRsCommitsQueryVariables>(
          repoPRsCommitsQuery,
          {owner, name},
          (data) => data.repository && data.repository.pullRequests);
  const oids = [];

  for await (const data of results) {
    if (!data.repository) {
      continue;
    }

    for (const pr of data.repository.pullRequests.nodes || []) {
      // Ignore unreviewed pull requests.
      if (!pr || getReviewsForPullRequest(pr).length === 0) {
        continue;
      }

      if (pr.mergeCommit) {
        oids.push(pr.mergeCommit);
      }

      for (const prCommit of pr.commits.nodes || []) {
        if (prCommit) {
          oids.push(prCommit.commit);
        }
      }

      // More than one page of commits, we need to fetch all the commits
      // separately.
      if (pr.commits.pageInfo.hasNextPage) {
        oids.push(...await getFullCommitsForPR(github, pr.id));
      }
    }
  }

  return oids;
}

/**
 * Fetches all associated commits for a given pull request specified by id. Does
 * not include the merge commit.
 */
async function getFullCommitsForPR(
    github: GitHub, id: string): Promise<Commit[]> {
  const results = github.cursorQuery<
      PullRequestCommitsQuery,
      PullRequestCommitsQueryVariables>(
      pullRequestCommitsQuery, {id}, (data) => {
        if (!data.node || data.node.__typename !== 'PullRequest') {
          return null;
        }
        return data.node.commits;
      });
  const commits = [];
  for await (const data of results) {
    if (!data.node || data.node.__typename !== 'PullRequest') {
      continue;
    }
    for (const prCommit of data.node.commits.nodes || []) {
      if (prCommit) {
        commits.push(prCommit.commit);
      }
    }
  }
  return commits;
}

// Fetches all the commits on the default branch (usually master) of the
// specified repo.
const repoCommitsQuery = gql`
  query RepoCommits($owner: String!, $name: String!, $cursor: String, $since: GitTimestamp) {
    repository(owner: $owner, name: $name) {
      defaultBranchRef {
        target {
          ... on Commit {
            history(first: 100, after: $cursor, since: $since) {
              pageInfo {
                endCursor
                hasNextPage
              }
              nodes {
                oid
                committedDate
              }
            }
          }
        }
      }
    }
  }`;

// Fetches all pull requests, using pagination, for a given repo. Also fetches
// the first 10 associated commits per pull request, indicating whether or not
// there are more results.
const repoPRsCommitsQuery = gql`
query RepoPRsCommits($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $cursor) {
      pageInfo {
        endCursor
        hasNextPage
      }
      nodes {
        author {
          login
        }
        createdAt
        id
        reviews(first: 20, states: [APPROVED, CHANGES_REQUESTED, COMMENTED]) {
          nodes {
            author {
              login
            }
            submittedAt
          }
        }
        mergeCommit {
          oid
          committedDate
        }
        commits(first: 10) {
          pageInfo {
            hasNextPage
          }
          nodes {
            commit {
              oid
              committedDate
            }
          }
        }
      }
    }
  }
}
  `;

// Fetches all the commits associated with the specified pull request.
const pullRequestCommitsQuery = gql`
query PullRequestCommits($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on PullRequest {
      commits(first: 100, after: $cursor) {
        pageInfo {
          endCursor
          hasNextPage
        }
        nodes {
          commit {
            oid
            committedDate
          }
        }
      }
    }
  }
}
  `;
