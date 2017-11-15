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

import * as commandLineArgs from 'command-line-args';

import {GitHub} from './gql';
import {getIssueCounts} from './metrics/issue-counts';
import {getReviewLatency} from './metrics/review-latency';
import {getReviewCoverage} from './metrics/review-coverage';

const commandLineUsage = require('command-line-usage') as any;

const argDefs = [
  {
    name: 'help',
    type: Boolean,
    description: 'Print this help text',
  },
  {
    name: 'metric',
    type: String,
    description: 'Name of the metric to measure (review-latency, issue-counts)',
  },
  {
    name: 'raw',
    type: Boolean,
    defaultValue: false,
    description: 'Dumps the raw data relevant to the provided metric',
  },
  {
    name: 'org',
    type: String,
    description: 'Name of the GitHub org to measure',
  },
  {
    name: 'repo',
    type: String,
    description: 'Optional. Owner/name of the GitHub repo to measure',
  },
];

export async function run(argv: string[]) {
  const args = commandLineArgs(argDefs, {argv});

  if (args.help) {
    console.log(commandLineUsage([
      {
        header: `[blue]{Project Health metrics}`,
        content: 'https://github.com/PolymerLabs/project-health',
      },
      {
        header: `Options`,
        optionList: argDefs,
      }
    ]));
    return;
  }

  if (!args.metric) {
    throw new Error('No metric specified');
  }

  if (!args.org) {
    throw new Error('No GitHub org specified');
  }

  const github = new GitHub();

  if (args.metric === 'review-latency') {
    const result =
        await getReviewLatency(github, {org: args.org, repo: args.repo});
    if (!args.raw) {
      console.info(result.format());
    } else {
      result.logRawData();
    }

  } else if (args.metric === 'issue-counts') {
    const counts =
        await getIssueCounts(github, {org: args.org, repo: args.repo});
    if (args.raw) {
      for (const point of counts.timeSeries()) {
        console.log([point.date, point.numOpened, point.numClosed].join('\t'));
      }
    } else {
      console.info(counts.summary());
    }
  } else if (args.metric === 'review-coverage') {
    const result = await getReviewCoverage(github, {org: args.org, repo: args.repo});
    // TODO: Implement a raw API.
    if (!args.raw) {
      console.log(result.summary());
    }
  } else {
    throw new Error('Metric not found');
  }
}
