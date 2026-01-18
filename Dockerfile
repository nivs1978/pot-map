# syntax=docker/dockerfile:1

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS base
WORKDIR /app
EXPOSE 8001
ENV ASPNETCORE_URLS=http://+:8001

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG PROJECT_DIR=PotMap
ARG PROJECT_FILE=PotMap.csproj
WORKDIR /src
COPY ["${PROJECT_DIR}/${PROJECT_FILE}", "${PROJECT_DIR}/"]
RUN dotnet restore "${PROJECT_DIR}/${PROJECT_FILE}"
COPY . .
WORKDIR /src/${PROJECT_DIR}
RUN dotnet publish "${PROJECT_FILE}" -c Release -o /app/publish /p:UseAppHost=false

ARG PROJECT_DIR=PotMap

FROM base AS final
ARG PROJECT_DIR=PotMap
WORKDIR /app
COPY --from=build /app/publish .
COPY --from=build /src/${PROJECT_DIR}/wwwroot/tiles ./wwwroot/tiles
ENTRYPOINT ["dotnet", "PotMap.dll"]
