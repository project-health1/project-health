import * as bodyParser from 'body-parser';
import * as cookieParser from 'cookie-parser';
import * as express from 'express';
import {Server} from 'http';
import * as path from 'path';
import * as request from 'request-promise-native';
import gql from 'graphql-tag';

import {DashResponse, OutgoingPullRequest} from '../types/api';

import {getLoginFromRequest} from './utils/login-from-request';
import {GitHub} from '../utils/github';
import {ViewerPullRequestsQuery} from '../types/gql-types';
import {getRouter as getWebhookRouter} from './apis/webhook';
import {getRouter as getPushSubRouter} from './apis/push-subscription';

class DashSecrets {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

export class DashServer {
  private secrets: DashSecrets;
  private github: GitHub;
  private app: express.Express;

  constructor(github: GitHub, secrets: DashSecrets) {
    this.github = github;
    this.secrets = secrets;

    const app = express();
    const litPath = path.join(__dirname, '../../node_modules/lit-html');

    app.use(cookieParser());
    app.use('/node_modules/lit-html', express.static(litPath));
    app.use(express.static(path.join(__dirname, '../client')));

    app.get('/dash.json', this.handleDashJson.bind(this));
    app.post('/login', bodyParser.text(), this.handleLogin.bind(this));

    app.use('/api/push-subscription/', getPushSubRouter(this.github));
    app.use('/api/webhook/', getWebhookRouter());

    this.app = app;
  }

  listen() {
    const port = Number(process.env.PORT || '') || 8080;
    let server: Server;
    const printStatus = () => {
      const addr = server.address();
      let urlHost = addr.address;
      if (addr.family === 'IPv6') {
        urlHost = '[' + urlHost + ']';
      }
      console.log('project health server listening');
      console.log(`http://${urlHost}:${addr.port}`);
    };

    if (process.env.NODE_ENV === 'production') {
      server = this.app.listen(port, printStatus);
    } else {
      server = this.app.listen(port, 'localhost', printStatus);
    }
  }

  async handleLogin(req: express.Request, res: express.Response) {
    if (!req.body) {
      res.sendStatus(400);
      return;
    }
    const postResp = await request.post({
      url: 'https://github.com/login/oauth/access_token',
      headers: {'Accept': 'application/json'},
      form: {
        'client_id': this.secrets.GITHUB_CLIENT_ID,
        'client_secret': this.secrets.GITHUB_CLIENT_SECRET,
        'code': req.body,
      },
      json: true,
    });

    if (postResp['error']) {
      console.log(postResp);
      res.sendStatus(500);
      return;
    }

    res.cookie('id', postResp['access_token'], {httpOnly: true});
    res.end();
  }

  async handleDashJson(req: express.Request, res: express.Response) {
    const loginDetails = await getLoginFromRequest(this.github, req);
    if (!loginDetails) {
      res.send(401);
      return;
    }

    const userData = await this.fetchUserData(loginDetails.username, loginDetails.token);
    res.header('content-type', 'application/json');
    res.send(JSON.stringify(userData, null, 2));
  }

  async fetchUserData(login: string, token: string): Promise<DashResponse> {
    const incomingReviewsQuery =
        `is:open is:pr review-requested:${login} archived:false`;

    const result = await this.github.query<ViewerPullRequestsQuery>({
      query: prsQuery,
      variables: {login, query: incomingReviewsQuery},
      fetchPolicy: 'network-only',
      context: {token}
    });
    const outgoingPrs = [];
    if (result.data.user) {
      for (const pr of result.data.user.pullRequests.nodes || []) {
        if (!pr) {
          continue;
        }
        const object: OutgoingPullRequest = {
          repository: pr.repository.nameWithOwner,
          title: pr.title,
          createdAt: Date.parse(pr.createdAt),
          url: pr.url,
          avatarUrl: '',
          author: '',
          reviews: [],
          reviewRequests: [],
        };
        if (pr.author && pr.author.__typename === 'User') {
          object.author = pr.author.login;
          object.avatarUrl = pr.author.avatarUrl;
        }

        if (pr.reviewRequests) {
          for (const request of pr.reviewRequests.nodes || []) {
            if (!request || !request.requestedReviewer ||
                request.requestedReviewer.__typename !== 'User') {
              continue;
            }
            object.reviewRequests.push(request.requestedReviewer.login);
          }
        }

        if (pr.reviews && pr.reviews.nodes) {
          for (const review of pr.reviews.nodes) {
            if (!review) {
              continue;
            }
            const result = {
              author: '',
              createdAt: Date.parse(review.createdAt),
              reviewState: review.state,
            };
            if (review.author && review.author.__typename === 'User') {
              result.author = review.author.login;
            }
            object.reviews.push(result);
          }
          pr.reviews.nodes.map((review) => {
            if (!review) {
              return {};
            }
          });
        }

        outgoingPrs.push(object);
      }
    }
    return {outgoingPrs};
  }
}

const prsQuery = gql`
query ViewerPullRequests($login: String!, $query: String!) {
	user(login: $login) {
    pullRequests(last: 10, states: [OPEN]) {
      nodes {
        ...prFields
        ...statusFields
        reviews(last: 10) {
          totalCount
          nodes {
            createdAt
            state
            author {
              login
            }
          }
        }
        reviewRequests(last: 2) {
          totalCount
          nodes {
            requestedReviewer {
              __typename
              ... on User {
                login
              }
            }
          }
        }
      }
    }
  }
  incomingReviews: search(type: ISSUE, query: $query, last: 10) {
    nodes {
      __typename
      ... on PullRequest {
        ...prFields
      }
    }
  }
  rateLimit {
    cost
    limit
    remaining
    resetAt
    nodeCount
  }
}

fragment prFields on PullRequest {
  repository {
    nameWithOwner
  }
  title
  url
  createdAt
  author {
    avatarUrl
    login
    url
  }
}

fragment statusFields on PullRequest {
	commits(last: 1) {
    nodes {
      commit {
        status {
          contexts {
            id
            context
            state
            createdAt
          }
          state
        }
      }
    }
  }
}`;
