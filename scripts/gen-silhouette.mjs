#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CANVASES = [
  { name: "easy", rows: 8, cols: 10 },
  { name: "normal", rows: 10, cols: 13 },
  { name: "hard", rows: 12, cols: 16 },
];
const DIRECTIONS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  let imagePath;
  let name;
  let threshold = 0.4;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--name" || argument === "--threshold") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`${argument} 옵션에 값이 필요합니다.`);
      }
      index += 1;
      if (argument === "--name") name = value;
      else threshold = Number(value);
      continue;
    }

    if (argument.startsWith("--name=")) {
      name = argument.slice("--name=".length);
      continue;
    }
    if (argument.startsWith("--threshold=")) {
      threshold = Number(argument.slice("--threshold=".length));
      continue;
    }
    if (argument.startsWith("--")) fail(`알 수 없는 옵션입니다: ${argument}`);
    if (imagePath) fail(`입력 이미지는 하나만 지정할 수 있습니다: ${argument}`);
    imagePath = argument;
  }

  if (!imagePath) {
    fail(
      "사용법: node scripts/gen-silhouette.mjs <image.png> [--name pikachu] [--threshold 0.4]",
    );
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    fail("--threshold는 0보다 크고 1 이하인 숫자여야 합니다.");
  }

  const fallbackName = basename(imagePath, extname(imagePath));
  if (name === undefined) name = fallbackName;
  if (!name.trim()) fail("--name은 비어 있을 수 없습니다.");

  return { imagePath, name, threshold };
}

function paethPredictor(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);

  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function unfilterScanlines(data, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const expectedLength = height * (stride + 1);
  if (data.length !== expectedLength) {
    fail(
      `PNG 압축 데이터 크기가 올바르지 않습니다(예상 ${expectedLength}바이트, 실제 ${data.length}바이트).`,
    );
  }

  const pixels = Buffer.alloc(height * stride);
  let sourceOffset = 0;

  for (let row = 0; row < height; row += 1) {
    const filter = data[sourceOffset];
    sourceOffset += 1;
    if (filter > 4) fail(`지원하지 않는 PNG 스캔라인 필터입니다: ${filter}`);

    const rowOffset = row * stride;
    const previousOffset = rowOffset - stride;

    for (let column = 0; column < stride; column += 1) {
      const raw = data[sourceOffset + column];
      const left = column >= bytesPerPixel ? pixels[rowOffset + column - bytesPerPixel] : 0;
      const up = row > 0 ? pixels[previousOffset + column] : 0;
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? pixels[previousOffset + column - bytesPerPixel]
          : 0;
      let value;

      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else value = raw + paethPredictor(left, up, upperLeft);

      pixels[rowOffset + column] = value & 0xff;
    }

    sourceOffset += stride;
  }

  return pixels;
}

function decodePng(buffer) {
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail("입력 파일이 유효한 PNG가 아닙니다.");
  }

  let offset = 8;
  let header;
  let ended = false;
  const idatChunks = [];

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) fail("PNG 청크가 중간에 잘렸습니다.");
    const length = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > buffer.length) fail("PNG 청크 길이가 파일 크기를 벗어납니다.");

    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset = chunkEnd;

    if (type === "IHDR") {
      if (header) fail("PNG에 IHDR 청크가 두 개 이상 있습니다.");
      if (length !== 13) fail("PNG IHDR 청크 길이가 올바르지 않습니다.");
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      ended = true;
      break;
    }
  }

  if (!header) fail("PNG에 IHDR 청크가 없습니다.");
  if (!ended) fail("PNG에 IEND 청크가 없습니다.");
  if (header.width === 0 || header.height === 0) fail("PNG 크기는 0일 수 없습니다.");
  if (header.bitDepth !== 8) {
    fail(`지원하지 않는 PNG 비트 깊이입니다: ${header.bitDepth} (8-bit만 지원)`);
  }
  if (header.colorType !== 2 && header.colorType !== 6) {
    fail(`지원하지 않는 PNG colorType입니다: ${header.colorType} (2·6만 지원)`);
  }
  if (header.interlace !== 0) {
    fail(`지원하지 않는 인터레이스 PNG입니다: ${header.interlace} (논인터레이스만 지원)`);
  }
  if (header.compression !== 0 || header.filter !== 0) {
    fail("지원하지 않는 PNG 압축 또는 필터 방식입니다.");
  }
  if (idatChunks.length === 0) fail("PNG에 IDAT 청크가 없습니다.");

  let inflated;
  try {
    inflated = inflateSync(Buffer.concat(idatChunks));
  } catch (error) {
    fail(`PNG IDAT 압축 해제에 실패했습니다: ${error.message}`);
  }

  const bytesPerPixel = header.colorType === 2 ? 3 : 4;
  return {
    ...header,
    bytesPerPixel,
    pixels: unfilterScanlines(inflated, header.width, header.height, bytesPerPixel),
  };
}

function createForegroundMask(image) {
  const mask = new Uint8Array(image.width * image.height);
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const pixelOffset = (y * image.width + x) * image.bytesPerPixel;
      const red = image.pixels[pixelOffset];
      const green = image.pixels[pixelOffset + 1];
      const blue = image.pixels[pixelOffset + 2];
      const alpha = image.colorType === 6 ? image.pixels[pixelOffset + 3] : 255;
      const isBackground = alpha < 40 || (red > 238 && green > 238 && blue > 238);

      if (!isBackground) {
        mask[y * image.width + x] = 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX < 0) fail("전경 픽셀이 0개입니다.");
  return { mask, bounds: { minX, minY, maxX: maxX + 1, maxY: maxY + 1 } };
}

function foregroundArea(mask, imageWidth, x0, y0, x1, y1) {
  let area = 0;
  const startX = Math.floor(x0);
  const endX = Math.ceil(x1);
  const startY = Math.floor(y0);
  const endY = Math.ceil(y1);

  for (let y = startY; y < endY; y += 1) {
    const yOverlap = Math.min(y1, y + 1) - Math.max(y0, y);
    if (yOverlap <= 0) continue;

    for (let x = startX; x < endX; x += 1) {
      if (mask[y * imageWidth + x] === 0) continue;
      const xOverlap = Math.min(x1, x + 1) - Math.max(x0, x);
      if (xOverlap > 0) area += xOverlap * yOverlap;
    }
  }

  return area;
}

function sampleCanvas(foreground, imageWidth, canvas, threshold) {
  const { mask, bounds } = foreground;
  const sourceWidth = bounds.maxX - bounds.minX;
  const sourceHeight = bounds.maxY - bounds.minY;
  const boardWidth = canvas.cols * 5;
  const boardHeight = canvas.rows * 7;
  const scale = Math.min(boardWidth / sourceWidth, boardHeight / sourceHeight);
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  const renderedX = (boardWidth - renderedWidth) / 2;
  const renderedY = (boardHeight - renderedHeight) / 2;
  const cells = Array.from({ length: canvas.rows }, () => Array(canvas.cols).fill(false));

  for (let row = 0; row < canvas.rows; row += 1) {
    for (let column = 0; column < canvas.cols; column += 1) {
      const cellX0 = column * 5;
      const cellY0 = row * 7;
      const overlapX0 = Math.max(cellX0, renderedX);
      const overlapY0 = Math.max(cellY0, renderedY);
      const overlapX1 = Math.min(cellX0 + 5, renderedX + renderedWidth);
      const overlapY1 = Math.min(cellY0 + 7, renderedY + renderedHeight);

      if (overlapX0 >= overlapX1 || overlapY0 >= overlapY1) continue;

      const sourceX0 = bounds.minX + (overlapX0 - renderedX) / scale;
      const sourceY0 = bounds.minY + (overlapY0 - renderedY) / scale;
      const sourceX1 = bounds.minX + (overlapX1 - renderedX) / scale;
      const sourceY1 = bounds.minY + (overlapY1 - renderedY) / scale;
      const coveredArea = foregroundArea(
        mask,
        imageWidth,
        sourceX0,
        sourceY0,
        sourceX1,
        sourceY1,
      );
      const coverage = (coveredArea * scale * scale) / (5 * 7);
      cells[row][column] = coverage + Number.EPSILON >= threshold;
    }
  }

  return cells;
}

function findIslands(cells) {
  const rows = cells.length;
  const cols = cells[0].length;
  const visited = Array.from({ length: rows }, () => Array(cols).fill(false));
  const islands = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      if (!cells[row][column] || visited[row][column]) continue;

      const island = [];
      const queue = [[row, column]];
      visited[row][column] = true;

      for (let index = 0; index < queue.length; index += 1) {
        const [currentRow, currentColumn] = queue[index];
        island.push([currentRow, currentColumn]);

        for (const [rowOffset, columnOffset] of DIRECTIONS) {
          const nextRow = currentRow + rowOffset;
          const nextColumn = currentColumn + columnOffset;
          if (
            nextRow >= 0 &&
            nextRow < rows &&
            nextColumn >= 0 &&
            nextColumn < cols &&
            cells[nextRow][nextColumn] &&
            !visited[nextRow][nextColumn]
          ) {
            visited[nextRow][nextColumn] = true;
            queue.push([nextRow, nextColumn]);
          }
        }
      }

      islands.push(island);
    }
  }

  return islands;
}

function removeSmallIslands(cells) {
  for (const island of findIslands(cells)) {
    if (island.length >= 3) continue;
    for (const [row, column] of island) cells[row][column] = false;
  }
}

function countFilledNeighbors(cells, row, column) {
  let count = 0;
  for (const [rowOffset, columnOffset] of DIRECTIONS) {
    if (cells[row + rowOffset]?.[column + columnOffset]) count += 1;
  }
  return count;
}

function erodeTails(cells) {
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const endpoints = [];

    for (let row = 0; row < cells.length; row += 1) {
      for (let column = 0; column < cells[0].length; column += 1) {
        if (cells[row][column] && countFilledNeighbors(cells, row, column) === 1) {
          endpoints.push([row, column]);
        }
      }
    }

    if (endpoints.length === 0) break;
    for (const [row, column] of endpoints) cells[row][column] = false;
  }
}

function countFilled(cells) {
  return cells.reduce(
    (total, row) => total + row.reduce((rowTotal, cell) => rowTotal + Number(cell), 0),
    0,
  );
}

function isBoundaryCell(cells, row, column) {
  return DIRECTIONS.some(
    ([rowOffset, columnOffset]) => !cells[row + rowOffset]?.[column + columnOffset],
  );
}

function correctParity(cells) {
  if (countFilled(cells) % 2 === 0) return;

  const candidates = [];
  for (let row = 0; row < cells.length; row += 1) {
    for (let column = 0; column < cells[0].length; column += 1) {
      if (cells[row][column] && isBoundaryCell(cells, row, column)) {
        candidates.push({
          row,
          column,
          neighbors: countFilledNeighbors(cells, row, column),
        });
      }
    }
  }

  candidates.sort((a, b) => b.neighbors - a.neighbors || b.row - a.row || a.column - b.column);
  const islandCount = findIslands(cells).length;

  for (const candidate of candidates) {
    cells[candidate.row][candidate.column] = false;
    const islands = findIslands(cells);
    if (islands.length <= islandCount && islands.every((island) => island.length >= 3)) return;
    cells[candidate.row][candidate.column] = true;
  }

  const fallback = candidates[0];
  if (!fallback) fail("짝수 보정을 위한 경계 칸을 찾을 수 없습니다.");
  cells[fallback.row][fallback.column] = false;
}

function cleanCanvas(cells) {
  removeSmallIslands(cells);
  erodeTails(cells);
  correctParity(cells);
  return cells;
}

function toAscii(cells) {
  return cells.map((row) => row.map((cell) => (cell ? "#" : ".")).join(""));
}

function formatIslandReport(islands) {
  const sizes = islands.map((island) => island.length).sort((a, b) => b - a);
  return `섬 ${islands.length}개 — 크기 ${sizes.join(", ")}칸`;
}

function printResults(name, results) {
  for (const result of results) {
    console.log(`\n===== ${result.name} =====`);
    console.log(`${result.name} ${result.rows}×${result.cols} — 채움 ${result.filled}칸(짝수)`);
    console.log(result.ascii.join("\n"));
    console.log(formatIslandReport(result.islands));
  }

  console.log("\n===== shared/board.ts SILHOUETTES 스니펫 =====");
  console.log(`${JSON.stringify(name)}: {`);
  for (const result of results) {
    console.log(`  ${result.name}: [`);
    for (const row of result.ascii) console.log(`    ${JSON.stringify(row)},`);
    console.log("  ],");
  }
  console.log("},");
}

function main() {
  const { imagePath, name, threshold } = parseArguments(process.argv.slice(2));
  const image = decodePng(readFileSync(imagePath));
  const foreground = createForegroundMask(image);
  const results = CANVASES.map((canvas) => {
    const cells = cleanCanvas(sampleCanvas(foreground, image.width, canvas, threshold));
    const islands = findIslands(cells);
    const filled = countFilled(cells);
    if (filled === 0) fail(`${canvas.name} 캔버스의 전경 칸이 0개입니다.`);

    return { ...canvas, ascii: toAscii(cells), islands, filled };
  });

  printResults(name, results);
}

try {
  main();
} catch (error) {
  console.error(`오류: ${error.message}`);
  process.exitCode = 1;
}
