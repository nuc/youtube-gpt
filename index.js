#!/usr/bin/env node
require('dotenv').config()

const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { Readable } = require('stream');

const YOUTUBE_URL = process.argv[2];
const QUESTION = process.argv[3] || 'Please summarize the video';
const OUTPUT_FILE = 'output.mp3';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const JSON_FILE = 'transcriptions.json';
const QA_FILE = 'qa.json';

if (!YOUTUBE_URL) {
  console.error('Please provide a YouTube URL as a command-line argument.');
  process.exit(1);
}

if (!OPENAI_API_KEY) {
  console.error('Please provide an OpenAI API key in the .env file.');
  process.exit(1);
}

const videoId = new URL(YOUTUBE_URL).searchParams.get('v');

async function download(url) {
  try {
    // Download and convert YouTube video to MP3
    console.log('Downloading YouTube video...');
    await new Promise((resolve, reject) => {
      const videoStream = ytdl(url, { quality: 'lowestaudio', filter: 'audioonly' });
      const converter = ffmpeg(videoStream)
        .format('mp3')
        .on('error', reject)
        .on('end', resolve)
        .save(OUTPUT_FILE);
    });
    console.log('YouTube video downloaded and converted to MP3.');
  } catch (error) {
    console.error(error);
  }
}

async function splitFile(inputFile, maxChunkSize, outputDir) {
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
    // console.log(`File size: ${size} bytes, Max chunk size: ${maxChunkSizeBytes} bytes, Total chunks: ${totalChunks}`);

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
    const files = await splitFile(inputFile, maxChunkSize, '.');

    // console.log(files);

    let transcriptions = [];
    for (let i = 0; i < files.length; i++) {
      console.log(`Uploading chunk ${i + 1} of ${files.length} to OpenAI...`);
      const fileBuffer = fs.readFileSync(files[i]);
      const transcript = await uploadFileAndTranscribe(fileBuffer);
      transcriptions.push(transcript);

      // Remove the temporary file after uploading
      fs.unlinkSync(files[i]);
    }

    console.log('All chunks uploaded to OpenAI.');
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
    // console.log('Transcription:', transcript);
    return transcript;
  } catch (error) {
    console.error(error.response.data);
  }
}

async function saveTranscription(id, transcript) {
  console.log('Saving transcription to file...');
  let transcriptions = {};

  if (fs.existsSync(JSON_FILE)) {
    const fileContent = fs.readFileSync(JSON_FILE, 'utf-8');

    transcriptions = JSON.parse(fileContent);
  }

  transcriptions[id] = transcript;
  fs.writeFileSync(JSON_FILE, JSON.stringify(transcriptions, null, 2));
}

async function getTranscription(id) {
  if (fs.existsSync(JSON_FILE)) {
    const fileContent = fs.readFileSync(JSON_FILE, 'utf-8');
    const transcriptions = JSON.parse(fileContent);

    if (transcriptions[id]) {
      console.log('Transcription found in file.');
      return transcriptions[id];
    }
  }

  return null;
}

async function askGPT4(transcript, question) {
  console.log(`Asking GPT-4: ${question}`);
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
  // const prompt = `
  // Can this question be answered by these questions and answers?
  // Please answer with a 'yes' or 'no'.
  // ---
  // Question: ${question}
  // ---
  // Questions and answers:
  // ` + existingQA.map((qa) => `Q: ${qa.question} A: ${qa.answer}`).join('');
  // const response = await askGPT4(prompt, question);
  // console.log(response)
  // process.exit()
  // if (response.toLowerCase() === 'yes') {
  //   return qa.answer;
  // }
}

const run = async () => {
  let transcript = await getTranscription(videoId);

  if (!transcript) {
    await download(YOUTUBE_URL);
    transcript = await splitAndUpload(OUTPUT_FILE, MAX_FILE_SIZE);
    saveTranscription(videoId, transcript);
  }

  let answer = await findExistingAnswer(videoId, QUESTION);

  if (!answer) {
    answer = await askGPT4(transcript, QUESTION);
    console.log('GPT-4 Response:', answer);
    saveQA(videoId, QUESTION, answer);
  } else {
    console.log('Existing Answer:', answer);
  }
};

run();
