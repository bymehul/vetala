import readline from 'readline';
import axios from 'axios';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const JIKAN_API_BASE = 'https://api.jikan.moe/v4';

async function searchAnime(query) {
  try {
    const response = await axios.get(`${JIKAN_API_BASE}/anime?q=${encodeURIComponent(query)}`);
    return response.data.data;
  } catch (error) {
    console.error('Error searching for anime:', error.message);
    return [];
  }
}

function findClosestMatch(query, results) {
  if (results.length === 0) return null;
  
  // Simple prediction: return the first result (Jikan API already ranks by relevance)
  return results[0];
}

async function main() {
  console.log('Anime Search CLI');
  console.log('================');
  
  rl.question('Enter anime name: ', async (query) => {
    if (!query.trim()) {
      console.log('Please enter a valid anime name.');
      rl.close();
      return;
    }
    
    console.log(`\nSearching for: "${query}"\n`);
    
    const results = await searchAnime(query);
    
    if (results.length === 0) {
      console.log('No results found.');
    } else {
      const closestMatch = findClosestMatch(query, results);
      console.log('Closest Match:');
      console.log(`Title: ${closestMatch.title}`);
      console.log(`Type: ${closestMatch.type}`);
      console.log(`Episodes: ${closestMatch.episodes}`);
      console.log(`Score: ${closestMatch.score}`);
      console.log(`URL: ${closestMatch.url}`);
    }
    
    rl.close();
  });
}

main();