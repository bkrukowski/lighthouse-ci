/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const bodyParser = require('body-parser');
const express = require('express');
const fetch = require('node-fetch'); // polyfill
const LighthouseCI = require('./lighthouse-ci');

const WPT_API_KEY = 'A.04c7244ba25a5d6d717b0343a821aa59';
const WPT_PR_MAP = new Map();

const GITHUB_PENDING_STATUS = {
  state: 'pending',
  description: 'Auditing PR changes...'
};

const CI = new LighthouseCI(process.env.OAUTH_TOKEN);
const API_KEY_HEADER = 'X-API-KEY';

const app = express();
app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());
app.use(express.static('public', {
  extensions: ['html', 'htm'],
}));

app.get('/', (req, res) => {
  res.status(200).send(
      'See https://github.com/ebidel/lighthouse-ci for documentation.');
});

app.get('/wpt_ping', (req, res) => {
  const wptTestId = req.query.id;

  if (!WPT_PR_MAP.has(wptTestId)) {
    res.status(404).send('Unknown WebPageTest id.');
    return;
  }

  const {prInfo, config} = WPT_PR_MAP.get(wptTestId);

  fetch(`https://www.webpagetest.org/jsonResult.php?test=${wptTestId}`)
    .then(resp => resp.json())
    .then(json => {
      if (!json.data || !json.data.lighthouse) {
        console.log(json);
        throw new Error(
            'Lighthouse results were not found in WebPageTest results.');
      }

      const opts = Object.assign({
        target_url: `https://www.webpagetest.org/lighthouse.php?test=${wptTestId}`
      }, prInfo);

      const lhResults = json.data.lighthouse;

      return CI.assignPassFailToPR(lhResults, config, opts).then(score => {
        WPT_PR_MAP.delete(wptTestId); // Cleanup
        res.status(200).send({score});
      });
    })
    .catch(err => {
      CI.handleError(err, prInfo);
      res.json(err);
    });
});

app.post('/run_on_wpt', (req, res) => {
  const config = Object.assign({
    pingbackUrl: `${req.protocol}://${req.get('host')}/wpt_ping`
  }, req.body);
  const testUrl = config.testUrl;

  const prInfo = {
    repo: config.repo.name,
    owner: config.repo.owner,
    sha: config.pr.sha
  };

  return CI.startOnWebpageTest(WPT_API_KEY, testUrl, config.pingbackUrl)
    .then(json => {
      if (!json.data || !json.data.testId) {
        throw new Error(
            'Lighthouse results were not found in WebPageTest results.');
      }

      // stash wpt id -> github pr sha mapping.
      WPT_PR_MAP.set(json.data.testId, {prInfo, config});

      return CI.updateGithubStatus(Object.assign({
        target_url: json.data.userUrl
      }, prInfo, GITHUB_PENDING_STATUS));
    })
    .then(result => {
      res.status(200).send(result);
    })
    .catch(err => {
      CI.handleError(err, prInfo);
      res.status(500).send(err.message);
    });
});

app.post('/run_on_chrome', (req, res) => {
  const config = Object.assign({}, req.body);
  const testUrl = config.testUrl;

  const prInfo = {
    repo: config.repo.name,
    owner: config.repo.owner,
    sha: config.pr.sha
  };

  // // Require an API key from users.
  // if (!req.get(API_KEY_HEADER)) {
  //   const msg = `${API_KEY_HEADER} is missing`;
  //   const err = new Error(msg);
  //   CI.handleError(err, prInfo);
  //   res.status(403).json(err.message);
  //   return;
  // }

  CI.updateGithubStatus(Object.assign({}, prInfo, GITHUB_PENDING_STATUS))
     // eslint-disable-next-line no-unused-vars
    .then(status => CI.testOnHeadlessChrome(
        {format: config.format, url: testUrl},
        {[API_KEY_HEADER]: req.get(API_KEY_HEADER)}))
    .then(lhResults => {
      const opts = Object.assign({target_url: testUrl}, prInfo);

      return CI.assignPassFailToPR(lhResults, config, opts).then(score => {
        res.status(200).send({score});
      });
    })
    .catch(err => {
      CI.handleError(err, prInfo);
      res.json(err);
    });
});

// app.post('/github_webhook', async (req, res) => {
//   if (!('x-github-event' in req.headers)) {
//     res.status(400).send('Not a request from Github.');
//     return;
//   }

//   // Ignore non-pull request events.
//   if (req.headers['x-github-event'] !== 'pull_request') {
//     res.status(200).send('Not a pull request event.');
//     return;
//   }

//   if (['opened', 'reopened', 'synchronize'].includes(req.body.action)) {
//     const prInfo = {
//       owner: req.body.repository.full_name.split('/')[0],
//       repo: req.body.repository.full_name.split('/')[1],
//       number: req.body.number,
//       sha: req.body.pull_request.head.sha
//     }

//     try {
//       const status = Object.assign({}, prInfo, GITHUB_PENDING_STATUS);
//       const result = await CI.updateGithubStatus(status);
//     } catch (err) {
//       CI.handleError(err, prInfo);
//     }

//     const headers = {[API_KEY_HEADER]: req.get(API_KEY_HEADER)};
//     const lhResults = await CI.testOnHeadlessChrome({
//       format: 'json',
//       url: 'https://www.chromestatus.com/features'
//     }, headers);

//     try {
//       await CI.postLighthouseComment(prInfo, lhResults);
//       res.status(200).send('Lighthouse comment posted to PR.');
//     } catch (err) {
//       res.json('Error posting Lighthouse comment to PR.');
//     }

//     try {
//       const result = await CI.updateGithubStatus(Object.assign({
//         description: 'Auditing complete. See scores above.',
//         state: 'success'
//       }, prInfo));
//     } catch (err) {
//       CI.handleError(err, prInfo);
//     }
//   } else {
//     res.status(200).send('');
//   }
// });

app.post('/add_github_comment', async (req, res) => {
  const config = Object.assign({}, req.body);

  const prInfo = {
    repo: config.repo.name,
    owner: config.repo.owner,
    number: config.pr.number,
    sha: config.pr.sha
  };

  // GH status update: inform user LH has started auditing.
  try {
    const status = Object.assign({}, prInfo, GITHUB_PENDING_STATUS);
    const result = await CI.updateGithubStatus(status);
  } catch (err) {
    CI.handleError(err, prInfo);
  }

  // Run Lighthouse CI against PR changes.
  const headers = {[API_KEY_HEADER]: req.get(API_KEY_HEADER)};
  const lhResults = await CI.testOnHeadlessChrome({
    format: 'json',
    url: config.testUrl
  }, headers);

  // GH status update: inform user LH is done!
  try {
    const result = await CI.updateGithubStatus(Object.assign({
      description: 'Auditing complete. See scores above.',
      state: 'success'
    }, prInfo));
  } catch (err) {
    CI.handleError(err, prInfo);
  }

  // Post comment on issue with updated LH scores.
  try {
    const score = await CI.postLighthouseComment(prInfo, lhResults);
    res.status(200).send({score});
  } catch (err) {
    res.json('Error posting Lighthouse comment to PR.');
  }

  res.status(200).send({score: lhResults.score});
});

// app.get('/test_wpt', (req, res) => {
//   const pingbackUrl = 'https://14195295.ngrok.io/wpt_ping';
//   const testUrl = 'https://www.chromestatus.com/features';

//   return CI.startOnWebpageTest(testUrl, pingbackUrl)
//     .then(json => {
//       // stash wpt id -> github pr sha mapping.
//       WPT_PR_MAP.set(json.data.testId, {prInfo: {}, config: {}});

//       res.status(200).send(json.data.userUrl);
//     })
//     .catch(err => {
//       res.status(500).send(err.message);
//     });
// });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
  console.log('Press Ctrl+C to quit.');
});
