#!/usr/bin/env node
require('dotenv').config()

const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { Readable } = require('stream');
const { encode, decode } = require('gpt-3-encoder');
const path = require('path');
const wordWrap = require('word-wrap');

const YOUTUBE_URL = process.argv[2];
const QUESTION = process.argv[3] || 'Please summarize the video';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const JSON_FILE = 'transcriptions.json';
const QA_FILE = 'qa.json';
const MAX_TOKENS = 1000;
const TMP_DOWNLOADS = './tmp_downloads';

const logger = (message) => process.env.DEBUG_LOGS && console.log(message)

const CHUNK_SUMMARIZATION = false;

if (!YOUTUBE_URL) {
  console.error('Please provide a YouTube URL as a command-line argument.');
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  console.error('Please provide an OpenAI API key as an env var `OPENAI_API_KEY` (or in the .env file if you have cloned the repo).');
  process.exit(1);
}

const videoId = new URL(YOUTUBE_URL).searchParams.get('v');
let videoTitle

async function download(url) {
  try {
    // Download and convert YouTube video to MP3
    if (!fs.existsSync(TMP_DOWNLOADS)) {
      fs.mkdirSync(TMP_DOWNLOADS);
    }
    // Get basic info of the video including title
    const videoInfo = await ytdl.getBasicInfo(url);
    videoTitle = videoInfo.videoDetails.title;

    const audioPath = path.join(TMP_DOWNLOADS, `${videoId}.mp3`);
    if (fs.existsSync(audioPath)) {
      logger('Audio already exists, skipping download');
      return audioPath;
    }
    logger('Downloading YouTube video...');

    await new Promise((resolve, reject) => {
      const videoStream = ytdl(url, { quality: 'lowestaudio', filter: 'audioonly' });
      const converter = ffmpeg(videoStream)
        .format('mp3')
        .on('error', reject)
        .on('end', resolve)
        .save(audioPath);
    });
    logger('YouTube video downloaded and converted to MP3.');
    return audioPath
  } catch (error) {
    console.error(error);
  }
}

async function splitAudioFile(inputFile, maxChunkSize, outputDir) {
  try {
    const { size } = fs.statSync(inputFile);
    const maxChunkSizeBytes = maxChunkSize;

    const metadata = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputFile, (err, metadata) => {
        if (err) reject(err);
        resolve(metadata);
      });
    });

    const duration = metadata.format.duration;
    const bitrate = metadata.format.bit_rate / 8; // Convert to bytes per second
    const chunkDuration = Math.floor((maxChunkSizeBytes / bitrate) * 1000) / 1000; // Duration in seconds

    const totalChunks = Math.ceil(duration / chunkDuration);
    // logger(`File size: ${size} bytes, Max chunk size: ${maxChunkSizeBytes} bytes, Total chunks: ${totalChunks}`);

    const outputFiles = [];
    let currentChunk = 1;

    while (currentChunk <= totalChunks) {
      const outputFile = `${outputDir}/output_${currentChunk}.mp3`;
      outputFiles.push(outputFile);

      await new Promise((resolve, reject) => {
        const startTime = (currentChunk - 1) * chunkDuration;

        ffmpeg(inputFile)
          .seekInput(startTime)
          .duration(chunkDuration)
          .output(outputFile)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      currentChunk++;
    }

    return outputFiles;
  } catch (error) {
    console.error(error);
  }
}

// Function to split a file and upload the chunks to the OpenAI API for transcription
async function splitAndUpload(inputFile, maxChunkSize) {
  try {
    const files = await splitAudioFile(inputFile, maxChunkSize, '.');

    // logger(files);

    let transcriptions = [];
    for (let i = 0; i < files.length; i++) {
      logger(`Uploading chunk ${i + 1} of ${files.length} to OpenAI...`);
      const fileBuffer = fs.readFileSync(files[i]);
      const transcript = await uploadFileAndTranscribe(fileBuffer);
      transcriptions.push(transcript);

      // Remove the temporary file after uploading
      fs.unlinkSync(files[i]);
    }

    logger('All chunks uploaded to OpenAI.');
    return transcriptions.join(' ');
  } catch (error) {
    console.error(error);
  }
}

// Function to upload a file to the OpenAI API and return the transcription
async function uploadFileAndTranscribe(fileBuffer) {
  try {
    const formData = new FormData();
    formData.append('file', Buffer.from(fileBuffer), { filename: 'chunk.mp3' });
    formData.append('model', 'whisper-1');

    const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
      headers: {
        ...formData.getHeaders(),
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    });

    const transcript = response.data.text;
    // logger('Transcription:', transcript);
    return transcript;
  } catch (error) {
    console.error(error.response.data);
  }
}

async function saveTranscription(id, title, transcript, tokenCount, summarizedChunks) {
  logger('Saving transcription to file...');
  let transcriptions = {};

  if (fs.existsSync(JSON_FILE)) {
    const fileContent = fs.readFileSync(JSON_FILE, 'utf-8');
    transcriptions = JSON.parse(fileContent);
  }

  transcriptions[id] = { title, transcript, tokenCount, summarizedChunks };
  fs.writeFileSync(JSON_FILE, JSON.stringify(transcriptions, null, 2));
}

async function getTranscription(id) {
  if (fs.existsSync(JSON_FILE)) {
    const fileContent = fs.readFileSync(JSON_FILE, 'utf-8');
    const transcriptions = JSON.parse(fileContent);

    if (transcriptions[id]) {
      logger('Transcription found in file.');
      return transcriptions[id];
    }
  }

  return null;
}

async function askGPT4(transcript, question) {
  // logger(`Asking GPT-4: ${question} for transcript: ${transcript}`);
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4',
        temperature: 0.3,
        messages: [
          { role: 'system', content: `Transcript: ${transcript}` },
          { role: 'user', content: question },
        ],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      }
    );

    const answer = response.data.choices[0].message.content.trim();
    return answer;
  } catch (error) {
    console.error(error.response.data);
  }
}

async function saveQA(id, question, answer) {
  let qa = {};

  if (fs.existsSync(QA_FILE)) {
    const fileContent = fs.readFileSync(QA_FILE, 'utf-8');
    qa = JSON.parse(fileContent);
  }

  if (!qa[id]) {
    qa[id] = [];
  }

  qa[id].push({ question, answer });
  fs.writeFileSync(QA_FILE, JSON.stringify(qa, null, 2));
}

async function getQA(id) {
  if (fs.existsSync(QA_FILE)) {
    const fileContent = fs.readFileSync(QA_FILE, 'utf-8');
    const qa = JSON.parse(fileContent);

    if (qa[id]) {
      return qa[id];
    }
  }

  return [];
}

async function findExistingAnswer(id, question) {
  const existingQA = await getQA(id);

  const exists = existingQA.find((qa) => qa.question === question);
  if (exists) {
    return exists.answer;
  }
  return null;
}

async function splitTranscript(transcript, maxTokens) {
  const tokens = encode(transcript);
  const chunks = [];

  for (let i = 0; i < tokens.length;) {
    let end = i + maxTokens;
    while (end < tokens.length && tokens[end] !== encode('. ')[0]) {
      end--;
    }
    if (end >= tokens.length) {
      end = tokens.length - 1;
    } else {
      end++; // To include the full stop in the chunk
    }

    const chunkTokens = tokens.slice(i, end);
    const chunkText = decode(chunkTokens);
    chunks.push(chunkText);
    i = end;
  }

  return chunks;
}

const logResponse = ({ title, QUESTION, answer }) => {
  const response = `---------------------------
  VIDEO: ${title}
  ---------------------------
  QUESTION: ${QUESTION}
  ---------------------------
  ANSWER: ${answer}
  `;
  const wrappedResponse = wordWrap(response, { width: 80, indent: '  ' });
  console.log(wrappedResponse);
}

const run = async () => {
  console.log(`  --------------------------- `)
  console.log('  Generating answers...');
  let transcriptData = await getTranscription(videoId);

  if (!transcriptData) {
    const audioFile = await download(YOUTUBE_URL);
    const fullTranscript = await splitAndUpload(audioFile, MAX_FILE_SIZE);
    const tokenCount = encode(fullTranscript).length;

    if (tokenCount > 5000) {
      logger(`Transcript contains ${tokenCount} tokens. The output might be truncated.`);
    }

    let summarizedChunks = [];
    if (CHUNK_SUMMARIZATION && tokenCount > MAX_TOKENS) {
      const chunks = await splitTranscript(fullTranscript, MAX_TOKENS);

      for (const chunk of chunks) {
        const summary = await askGPT4(chunk, 'Please summarize this text');
        summarizedChunks.push(summary);
      }
    }

    transcriptData = { title: videoTitle, transcript: fullTranscript, tokenCount, summarizedChunks };
    saveTranscription(videoId, videoTitle, fullTranscript, tokenCount, summarizedChunks);
  }

  const { title, transcript, tokenCount, summarizedChunks } = transcriptData;

  let answer = await findExistingAnswer(videoId, QUESTION);

  if (!answer) {
    if (summarizedChunks && summarizedChunks.length > 0) {
      const summarizedTranscript = summarizedChunks.join(' ');
      answer = await askGPT4(summarizedTranscript, QUESTION);
    } else {
      answer = await askGPT4(transcript, QUESTION);
    }

    logger('GPT-4 Response:', answer);
    saveQA(videoId, QUESTION, answer);
  } else {
    logger('Existing Answer:', answer);
  }
  logResponse({ title, YOUTUBE_URL, QUESTION, answer });
};

run();
