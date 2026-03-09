#!/usr/bin/env node

const https = require('https');

function searchAnime(animeName) {
    const encodedName = encodeURIComponent(animeName);
    const url = `https://api.jikan.moe/v4/anime?q=${encodedName}`;
    
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            
            res.on('data', (chunk) => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', (error) => {
            reject(error);
        });
    });
}

function prompt(question) {
    const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    return new Promise((resolve) => {
        readline.question(question, (answer) => {
            readline.close();
            resolve(answer);
        });
    });
}

async function main() {
    console.log('Anime Search CLI');
    console.log('=================');
    
    try {
        const animeName = await prompt('Enter anime name: ');
        
        if (!animeName.trim()) {
            console.log('Please enter an anime name.');
            return;
        }
        
        console.log(`Searching for anime: ${animeName}...`);
        
        const result = await searchAnime(animeName);
        
        if (result && result.data && result.data.length > 0) {
            console.log('\nResults:');
            console.log('========');
            
            result.data.forEach((anime, index) => {
                console.log(`${index + 1}. ${anime.title} (${anime.type})`);
                console.log(`   URL: ${anime.url}`);
                console.log(`   Episodes: ${anime.episodes || 'Unknown'}`);
                console.log(`   Score: ${anime.score || 'N/A'}`);
                console.log('');
            });
        } else {
            console.log('No results found.');
        }
        
    } catch (error) {
        console.error('Error:', error.message);
    }
}

if (require.main === module) {
    main();
}

module.exports = { searchAnime };